#!/usr/bin/env python3
"""Author the faceted vertex-colour look of ChameleonPhysical.glb.

The physical chameleon deliberately stays a single skinned primitive.  This
script adds (or refreshes) one normalized RGBA8 COLOR_0 stream without touching
positions, normals, indices, skinning data, animations or topology.

Colours are authored in Blender-local space:
    forward = -X, lateral = Y, up = Z

The GLB itself uses glTF's Y-up space, so positions and normals are converted
before anatomical masks are evaluated.  Palette values are specified as sRGB
hex values and stored as linear factors, as required by glTF.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import tempfile
from typing import Iterable, Sequence


GLB_MAGIC = 0x46546C67
GLB_VERSION = 2
GLB_JSON_CHUNK = 0x4E4F534A
GLB_BIN_CHUNK = 0x004E4942
ARRAY_BUFFER = 34962

COMPONENT_FORMATS = {
    5120: ("b", 1),
    5121: ("B", 1),
    5122: ("h", 2),
    5123: ("H", 2),
    5125: ("I", 4),
    5126: ("f", 4),
}

TYPE_COMPONENTS = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}


def linear_rgba8(hex_colour: str) -> tuple[int, int, int, int]:
    """Convert a #RRGGBB sRGB colour to normalized linear RGBA8 storage."""

    value = hex_colour.removeprefix("#")
    if len(value) != 6:
        raise ValueError(f"expected #RRGGBB colour, got {hex_colour!r}")

    def channel(component: str) -> int:
        srgb = int(component, 16) / 255.0
        linear = srgb / 12.92 if srgb <= 0.04045 else ((srgb + 0.055) / 1.055) ** 2.4
        return max(0, min(255, round(linear * 255.0)))

    return channel(value[0:2]), channel(value[2:4]), channel(value[4:6]), 255


PALETTE_HEX = {
    "body_dark": "#467A3D",
    "body": "#68A84B",
    "body_light": "#88C65D",
    "motif_dark": "#3C6B3A",
    "motif": "#76B853",
    "motif_light": "#98CD68",
    "dorsal_dark": "#315D39",
    "dorsal": "#487E42",
    "dorsal_light": "#609B49",
    "belly_dark": "#8FA45B",
    "belly": "#B8C878",
    "belly_light": "#D1DA91",
    "crest_dark": "#817636",
    "crest": "#C4AD4A",
    "crest_light": "#D8C75E",
    "limb_dark": "#40713B",
    "limb": "#5D9843",
    "limb_light": "#7CB553",
    "palm_dark": "#718B45",
    "palm": "#A5B95C",
    "palm_light": "#C3CB77",
    "tail_dark": "#476F3B",
    "tail": "#639E47",
    "tail_light": "#82B454",
    "eye_turret_dark": "#AAA044",
    "eye_turret": "#D4C65A",
    "eye_turret_light": "#E6DC76",
    "iris_dark": "#985722",
    "iris": "#CF812D",
    "iris_light": "#E19A3A",
    "pupil": "#172222",
    "pupil_dark": "#0D1516",
    "highlight": "#FFF2C7",
}

PALETTE = {name: linear_rgba8(value) for name, value in PALETTE_HEX.items()}

EYE_CENTER_X = -0.473
EYE_CENTER_Z = 0.142
EYE_TURRET_AXES = (0.044, 0.042)
EYE_IRIS_AXES = (0.026, 0.026)
EYE_PUPIL_AXES = (0.010, 0.010)


def parse_glb(path: Path) -> tuple[dict, bytearray]:
    data = path.read_bytes()
    if len(data) < 20:
        raise ValueError(f"{path} is too small to be a GLB")
    magic, version, declared_length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != GLB_VERSION or declared_length != len(data):
        raise ValueError(f"{path} has an invalid GLB header")

    offset = 12
    chunks: list[tuple[int, bytes]] = []
    while offset < len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        start = offset + 8
        end = start + length
        if end > len(data):
            raise ValueError(f"{path} contains a truncated GLB chunk")
        chunks.append((chunk_type, data[start:end]))
        offset = end

    if len(chunks) != 2 or chunks[0][0] != GLB_JSON_CHUNK or chunks[1][0] != GLB_BIN_CHUNK:
        raise ValueError("physical chameleon must remain a self-contained JSON + BIN GLB")
    gltf = json.loads(chunks[0][1].decode("utf8").rstrip("\x00 "))
    declared_binary = gltf["buffers"][0]["byteLength"]
    binary = bytearray(chunks[1][1][:declared_binary])
    return gltf, binary


class Accessor:
    def __init__(self, gltf: dict, binary: bytearray, index: int):
        self.gltf = gltf
        self.binary = binary
        self.index = index
        self.data = gltf["accessors"][index]
        if "sparse" in self.data:
            raise ValueError(f"sparse accessor {index} is unsupported")
        self.count = self.data["count"]
        self.components = TYPE_COMPONENTS[self.data["type"]]
        try:
            component_format, self.component_bytes = COMPONENT_FORMATS[self.data["componentType"]]
        except KeyError as error:
            raise ValueError(f"unsupported component type in accessor {index}") from error
        self.format = "<" + component_format * self.components
        self.element_bytes = self.component_bytes * self.components
        view = gltf["bufferViews"][self.data["bufferView"]]
        self.stride = view.get("byteStride", self.element_bytes)
        self.start = view.get("byteOffset", 0) + self.data.get("byteOffset", 0)
        self.normalized = self.data.get("normalized", False)

    def read(self, element: int) -> tuple[float | int, ...]:
        values = struct.unpack_from(self.format, self.binary, self.start + element * self.stride)
        if not self.normalized:
            return values
        component_type = self.data["componentType"]
        if component_type == 5121:
            return tuple(value / 255.0 for value in values)
        if component_type == 5123:
            return tuple(value / 65535.0 for value in values)
        return values


def blender_vector(gltf_vector: Sequence[float]) -> tuple[float, float, float]:
    """Rotate a glTF Y-up vector into the Blender-local Z-up authoring frame."""

    x, y, z = gltf_vector
    return x, -z, y


def vector_length(vector: Sequence[float]) -> float:
    return math.sqrt(sum(value * value for value in vector))


def normalized(vector: Sequence[float]) -> tuple[float, float, float]:
    length = vector_length(vector)
    if length <= 1e-12:
        return 0.0, 0.0, 1.0
    return tuple(value / length for value in vector)


def average(vectors: Iterable[Sequence[float]]) -> tuple[float, ...]:
    values = list(vectors)
    return tuple(sum(vector[lane] for vector in values) / len(values) for lane in range(len(values[0])))


def hash01(x: int, y: int, z: int) -> float:
    value = (x * 0x8DA6B343) ^ (y * 0xD8163841) ^ (z * 0xCB1AB31F) ^ 0x9E3779B9
    value &= 0xFFFFFFFF
    value ^= value >> 16
    value = (value * 0x7FEB352D) & 0xFFFFFFFF
    value ^= value >> 15
    value = (value * 0x846CA68B) & 0xFFFFFFFF
    value ^= value >> 16
    return value / 0xFFFFFFFF


def smoothstep(value: float) -> float:
    return value * value * (3.0 - 2.0 * value)


def coherent_noise(point: Sequence[float], cell_size: float = 0.085) -> float:
    """Small deterministic value noise; adjacent facets share broad patches."""

    scaled = [value / cell_size for value in point]
    base = [math.floor(value) for value in scaled]
    fraction = [smoothstep(value - floor) for value, floor in zip(scaled, base)]
    result = 0.0
    for dx in (0, 1):
        wx = fraction[0] if dx else 1.0 - fraction[0]
        for dy in (0, 1):
            wy = fraction[1] if dy else 1.0 - fraction[1]
            for dz in (0, 1):
                wz = fraction[2] if dz else 1.0 - fraction[2]
                result += wx * wy * wz * hash01(base[0] + dx, base[1] + dy, base[2] + dz)
    return result


def group_weights(
    vertex_indices: Sequence[int],
    joints: Accessor,
    weights: Accessor,
    joint_names: Sequence[str],
) -> dict[str, float]:
    summary: dict[str, float] = {}
    scale = 1.0 / len(vertex_indices)
    for vertex in vertex_indices:
        vertex_joints = joints.read(vertex)
        vertex_weights = weights.read(vertex)
        for joint, weight in zip(vertex_joints, vertex_weights):
            if weight <= 0.0:
                continue
            name = joint_names[int(joint)]
            summary[name] = summary.get(name, 0.0) + float(weight) * scale
    return summary


def summed_group(summary: dict[str, float], predicate) -> float:
    return sum(weight for name, weight in summary.items() if predicate(name))


def shade_key(prefix: str, normal: Sequence[float], patch: float) -> str:
    # Keep value steps as pigmentation, not a baked key light.  The tiny
    # anatomical bias only separates exposed and sheltered facets; coherent
    # patches remain the dominant signal so a future global toon shader can
    # light the animal without doubling a fake local-space shadow.
    score = 0.08 * normal[2] + 0.12 * abs(normal[1]) + 0.80 * (patch - 0.5)
    if score < -0.18:
        return f"{prefix}_dark"
    if score > 0.20:
        return f"{prefix}_light"
    return prefix


def eye_masks(center: Sequence[float], normal: Sequence[float]) -> tuple[str | None, float]:
    x, y, z = center
    side = -1.0 if y < 0.0 else 1.0
    outward = side * normal[1]
    if side * y <= 0.075 or outward <= 0.25:
        return None, math.inf

    dx = x - EYE_CENTER_X
    dz = z - EYE_CENTER_Z
    turret = (dx / EYE_TURRET_AXES[0]) ** 2 + (dz / EYE_TURRET_AXES[1]) ** 2
    iris = (dx / EYE_IRIS_AXES[0]) ** 2 + (dz / EYE_IRIS_AXES[1]) ** 2
    pupil = (dx / EYE_PUPIL_AXES[0]) ** 2 + (dz / EYE_PUPIL_AXES[1]) ** 2
    if pupil <= 1.0 and outward > 0.65:
        return "pupil", pupil
    if iris <= 1.0 and outward > 0.65:
        return "iris", iris
    if turret <= 1.0:
        return "turret", turret
    return None, math.inf


def face_palette_key(
    center: Sequence[float],
    normal: Sequence[float],
    weights_by_group: dict[str, float],
) -> str:
    x, y, z = center
    patch = coherent_noise((x, y * 0.72, z), 0.09)

    tail_weight = summed_group(weights_by_group, lambda name: name.startswith("tail_"))
    digit_weight = summed_group(weights_by_group, lambda name: "digits_" in name)
    palm_weight = summed_group(weights_by_group, lambda name: "_palm." in name)
    limb_weight = summed_group(
        weights_by_group,
        lambda name: name.startswith("front_") or name.startswith("hind_"),
    )
    head_weight = weights_by_group.get("head", 0.0) + weights_by_group.get("jaw", 0.0)
    trunk_weight = summed_group(
        weights_by_group,
        lambda name: name in {"pelvis", "spine_01", "spine_02", "neck"},
    )

    eye, _ = eye_masks(center, normal)
    if eye == "pupil":
        return "pupil"
    if eye == "iris":
        angle = math.atan2(z - EYE_CENTER_Z, x - EYE_CENTER_X)
        sector = int(math.floor((angle + math.pi) / (math.tau / 6.0))) % 6
        return ("iris_light", "iris", "iris_dark", "iris", "iris_light", "iris")[sector]
    if eye == "turret":
        angle = math.atan2(z - EYE_CENTER_Z, x - EYE_CENTER_X)
        sector = int(math.floor((angle + math.pi) / (math.tau / 6.0))) % 6
        return ("eye_turret_light", "eye_turret", "eye_turret_dark",
                "eye_turret", "eye_turret_light", "eye_turret")[sector]

    crest_limit = 0.24 + 0.20 * x
    if abs(y) < 0.047 and -0.49 < x < 0.28 and z > crest_limit:
        return shade_key("crest", normal, patch)

    if tail_weight > 0.34:
        weighted_index = 0.0
        total = 0.0
        for name, weight in weights_by_group.items():
            if not name.startswith("tail_"):
                continue
            weighted_index += (int(name[-2:]) - 1) * weight
            total += weight
        coordinate = weighted_index / max(total, 1e-6) / 11.0
        irregular = math.sin(math.tau * (coordinate * 7.35 + 0.055 * (patch - 0.5)))
        if irregular > 0.52:
            return shade_key("tail", normal, min(1.0, patch + 0.28))
        if irregular < -0.62:
            return "tail_dark"
        return shade_key("tail", normal, patch)

    if digit_weight + palm_weight > 0.30:
        return shade_key("palm", normal, patch)
    if limb_weight > 0.34:
        return shade_key("limb", normal, patch)

    if normal[2] < -0.25 and z < 0.105 and tail_weight < 0.20:
        return shade_key("belly", normal, patch)
    if trunk_weight + head_weight > 0.30 and normal[2] > 0.24 and z > 0.135:
        return shade_key("dorsal", normal, patch)

    # Large coherent side patches, never per-triangle confetti.
    diagonal = math.sin(13.0 * x - 7.0 * z + 2.2 * math.sin(5.0 * y))
    if abs(normal[1]) > 0.24 and patch > 0.59 and diagonal > -0.10:
        return shade_key("motif", normal, patch)
    return shade_key("body", normal, patch)


def author_colours(gltf: dict, binary: bytearray) -> tuple[bytearray, dict]:
    meshes = gltf.get("meshes", [])
    primitives = [primitive for mesh in meshes for primitive in mesh.get("primitives", [])]
    if len(meshes) != 1 or len(primitives) != 1:
        raise ValueError("physical chameleon must have exactly one mesh and one primitive")
    primitive = primitives[0]
    for semantic in ("POSITION", "NORMAL", "JOINTS_0", "WEIGHTS_0"):
        if semantic not in primitive.get("attributes", {}):
            raise ValueError(f"physical chameleon is missing {semantic}")

    positions = Accessor(gltf, binary, primitive["attributes"]["POSITION"])
    normals = Accessor(gltf, binary, primitive["attributes"]["NORMAL"])
    joints = Accessor(gltf, binary, primitive["attributes"]["JOINTS_0"])
    weights = Accessor(gltf, binary, primitive["attributes"]["WEIGHTS_0"])
    indices = Accessor(gltf, binary, primitive["indices"])
    if not (positions.count == normals.count == joints.count == weights.count):
        raise ValueError("physical chameleon vertex streams have mismatched counts")
    if indices.count % 3:
        raise ValueError("physical chameleon index count is not triangular")

    skin = gltf["skins"][0]
    joint_names = [gltf["nodes"][node].get("name", f"joint_{joint}") for joint, node in enumerate(skin["joints"])]
    colours = bytearray(PALETTE["body"] * positions.count)
    assignments: dict[str, int] = {}
    pupil_faces: dict[int, list[tuple[float, tuple[int, int, int]]]] = {-1: [], 1: []}

    for triangle in range(indices.count // 3):
        vertex_indices = tuple(int(indices.read(triangle * 3 + lane)[0]) for lane in range(3))
        center = average(blender_vector(positions.read(vertex)) for vertex in vertex_indices)
        normal = normalized(average(blender_vector(normals.read(vertex)) for vertex in vertex_indices))
        weights_by_group = group_weights(vertex_indices, joints, weights, joint_names)
        key = face_palette_key(center, normal, weights_by_group)
        assignments[key] = assignments.get(key, 0) + 1
        colour = PALETTE[key]
        for vertex in vertex_indices:
            colours[vertex * 4:vertex * 4 + 4] = bytes(colour)

        eye, _ = eye_masks(center, normal)
        if eye == "pupil":
            side = -1 if center[1] < 0.0 else 1
            # Prefer one upper-forward triangular facet for a painted catchlight.
            score = 1.7 * (center[2] - EYE_CENTER_Z) - (center[0] - EYE_CENTER_X)
            pupil_faces[side].append((score, vertex_indices))

    for candidates in pupil_faces.values():
        if not candidates:
            continue
        _, vertex_indices = max(candidates, key=lambda candidate: candidate[0])
        for vertex in vertex_indices:
            colours[vertex * 4:vertex * 4 + 4] = bytes(PALETTE["highlight"])
        assignments["highlight"] = assignments.get("highlight", 0) + 1
        assignments["pupil"] = max(0, assignments.get("pupil", 0) - 1)

    existing_colour = primitive["attributes"].get("COLOR_0")
    if existing_colour is None:
        while len(binary) % 4:
            binary.append(0)
        colour_offset = len(binary)
        binary.extend(colours)
        colour_view = len(gltf.setdefault("bufferViews", []))
        gltf["bufferViews"].append({
            "buffer": 0,
            "byteOffset": colour_offset,
            "byteLength": len(colours),
            "target": ARRAY_BUFFER,
            "name": "Chameleon_Faceted_Palette_RGBA8",
        })
        colour_accessor = len(gltf.setdefault("accessors", []))
        gltf["accessors"].append({
            "bufferView": colour_view,
            "byteOffset": 0,
            "componentType": 5121,
            "normalized": True,
            "count": positions.count,
            "type": "VEC4",
            "min": [min(colours[lane::4]) for lane in range(4)],
            "max": [max(colours[lane::4]) for lane in range(4)],
            "name": "Chameleon_Faceted_Palette",
        })
        primitive["attributes"]["COLOR_0"] = colour_accessor
    else:
        colour_accessor = Accessor(gltf, binary, existing_colour)
        if (
            colour_accessor.data["componentType"] != 5121
            or colour_accessor.data["type"] != "VEC4"
            or not colour_accessor.data.get("normalized")
            or colour_accessor.count != positions.count
            or colour_accessor.stride != 4
        ):
            raise ValueError("existing COLOR_0 does not match the compact RGBA8 look contract")
        for vertex in range(positions.count):
            start = colour_accessor.start + vertex * colour_accessor.stride
            binary[start:start + 4] = colours[vertex * 4:vertex * 4 + 4]
        colour_accessor.data["min"] = [min(colours[lane::4]) for lane in range(4)]
        colour_accessor.data["max"] = [max(colours[lane::4]) for lane in range(4)]

    gltf["buffers"][0]["byteLength"] = len(binary)
    material = gltf["materials"][primitive["material"]]
    pbr = material.setdefault("pbrMetallicRoughness", {})
    pbr["baseColorFactor"] = [1.0, 1.0, 1.0, 1.0]
    pbr["metallicFactor"] = 0.0
    pbr["roughnessFactor"] = 0.78
    material["doubleSided"] = True
    material.setdefault("extras", {}).update({
        "look_contract_version": "1.0.0",
        "look_model": "faceted-anatomical-vertex-palette",
        "palette_colour_space": "linear-srgb",
        "global_toon_shader": "deferred",
    })

    mesh_nodes = [node for node in gltf["nodes"] if "mesh" in node]
    if len(mesh_nodes) != 1:
        raise ValueError("physical chameleon must have exactly one mesh node")
    mesh_nodes[0].setdefault("extras", {}).update({
        "look_contract_version": "1.0.0",
        "look_model": "faceted-anatomical-color0-rgba8-v1",
        "eye_style": "embedded-faceted-turret-iris-pupil-highlight-v1",
        "eye_palette_center_xz": [EYE_CENTER_X, EYE_CENTER_Z],
        "eye_palette_turret_axes": list(EYE_TURRET_AXES),
        "eye_palette_iris_axes": list(EYE_IRIS_AXES),
        "eye_palette_pupil_axes": list(EYE_PUPIL_AXES),
        "look_draw_calls": 1,
        "toon_shader": "deferred-global-treatment",
    })

    report = {
        "vertices": positions.count,
        "triangles": indices.count // 3,
        "palette_entries": len(set(tuple(colours[offset:offset + 4]) for offset in range(0, len(colours), 4))),
        "face_assignments": dict(sorted(assignments.items())),
        "colour_bytes": len(colours),
        "binary_bytes": len(binary),
        "position_accessor": primitive["attributes"]["POSITION"],
        "colour_accessor": primitive["attributes"]["COLOR_0"],
    }
    return binary, report


def encode_glb(gltf: dict, binary: bytearray) -> bytes:
    json_bytes = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    binary_bytes = bytes(binary)
    binary_bytes += b"\x00" * ((-len(binary_bytes)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(binary_bytes)
    return b"".join((
        struct.pack("<III", GLB_MAGIC, GLB_VERSION, total),
        struct.pack("<II", len(json_bytes), GLB_JSON_CHUNK),
        json_bytes,
        struct.pack("<II", len(binary_bytes), GLB_BIN_CHUNK),
        binary_bytes,
    ))


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(handle, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def main() -> None:
    repository = Path(__file__).resolve().parents[1]
    default_asset = repository / "public" / "assets" / "ChameleonPhysical.glb"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=default_asset)
    parser.add_argument("--output", type=Path, default=default_asset)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    source = args.source.resolve()
    output = args.output.resolve()
    gltf, binary = parse_glb(source)
    binary, report = author_colours(gltf, binary)
    result = encode_glb(gltf, binary)
    report.update({
        "source": str(source),
        "output": str(output),
        "glb_bytes": len(result),
        "glb_sha256": hashlib.sha256(result).hexdigest(),
        "palette": PALETTE_HEX,
    })
    atomic_write(output, result)
    if args.report:
        atomic_write(args.report.resolve(), (json.dumps(report, indent=2) + "\n").encode("utf8"))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
