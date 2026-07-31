"""Rebuild the physical chameleon from its preserved original geometry.

This script is intentionally executable in Blender background mode:

    blender --background blender/chameleon_physics_rig.blend \
        --python scripts/rebuild-chameleon-hybrid-asset.py

The original imported mesh is the geometric authority.  Body weights are
copied vertex-for-vertex from the former physics body.  The original curled
tail remains visually exact but is bound rigidly to the pelvis, so it adds no
unstable physical degrees of freedom.
"""

from __future__ import annotations

import json
import os
import struct
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector, kdtree


EXPECTED_SOURCE_VERTICES = 25_002
EXPECTED_SOURCE_POLYGONS = 50_000
EXPECTED_BODY_VERTICES = 17_796
EXPECTED_TAIL_VERTICES = 7_206
MAPPING_TOLERANCE = 1e-6

SOURCE_NAME = "Chameleon_Imported_Source"
ARMATURE_NAME = "Chameleon_Physics_Armature"
OUTPUT_NAME = "Chameleon_Physics_Body"
BODY_TEMPLATE_NAME = "Chameleon_Physics_Body_WeightTemplate"
TAIL_ARCHIVE_NAME = "Chameleon_Physics_Tail_ProceduralArchive"
ORIGINAL_BODY_NAME = "Chameleon_Physics_Body"
ORIGINAL_TAIL_NAME = "Chameleon_Physics_Tail"
RIG_COLLECTION_NAME = "Chameleon_Physics_Rig"
ARCHIVE_COLLECTION_NAME = "Chameleon_Physics_Archive"

SCRIPT_PATH = Path(__file__).resolve()
REPOSITORY_ROOT = SCRIPT_PATH.parent.parent
BLEND_PATH = REPOSITORY_ROOT / "blender" / "chameleon_physics_rig.blend"
OUTPUT_PATH = REPOSITORY_ROOT / "public" / "assets" / "ChameleonPhysical.glb"
TEMP_OUTPUT_PATH = OUTPUT_PATH.with_name(f".{OUTPUT_PATH.stem}.rebuild.tmp.glb")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(f"Chameleon hybrid asset: {message}")


def require_object(name: str, object_type: str | None = None) -> bpy.types.Object:
    obj = bpy.data.objects.get(name)
    require(obj is not None, f'object "{name}" is missing')
    if object_type is not None:
        require(obj.type == object_type, f'object "{name}" must be {object_type}, got {obj.type}')
    return obj


def move_exclusively_to_collection(obj: bpy.types.Object, collection: bpy.types.Collection) -> None:
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)


def connected_component_count(mesh: bpy.types.Mesh) -> int:
    adjacency = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        first, second = edge.vertices
        adjacency[first].append(second)
        adjacency[second].append(first)

    visited: set[int] = set()
    components = 0
    for start in range(len(adjacency)):
        if start in visited:
            continue
        components += 1
        pending = [start]
        visited.add(start)
        while pending:
            current = pending.pop()
            for neighbour in adjacency[current]:
                if neighbour not in visited:
                    visited.add(neighbour)
                    pending.append(neighbour)
    return components


def assert_closed_manifold(mesh: bpy.types.Mesh, label: str) -> None:
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        boundary_edges = sum(1 for edge in bm.edges if edge.is_boundary)
        non_manifold_edges = sum(1 for edge in bm.edges if not edge.is_manifold)
        wire_edges = sum(1 for edge in bm.edges if edge.is_wire)
        require(boundary_edges == 0, f"{label} has {boundary_edges} boundary edges")
        require(non_manifold_edges == 0, f"{label} has {non_manifold_edges} non-manifold edges")
        require(wire_edges == 0, f"{label} has {wire_edges} wire edges")
    finally:
        bm.free()
    require(connected_component_count(mesh) == 1, f"{label} must contain exactly one connected component")


def source_to_rig_matrix(source: bpy.types.Object, body_template: bpy.types.Object) -> Matrix:
    origin_shift = body_template.get("origin_shift")
    require(origin_shift is not None and len(origin_shift) == 3, "body template origin_shift is missing")

    transform = source.matrix_basis.copy()
    transform.translation = source.location - Vector(origin_shift)
    require(abs(transform.determinant()) > 1e-8, "source-to-rig transform is singular")
    return transform


def archive_legacy_objects() -> tuple[bpy.types.Object, bpy.types.Object, bpy.types.Collection]:
    archive = bpy.data.collections.get(ARCHIVE_COLLECTION_NAME)
    if archive is None:
        archive = bpy.data.collections.new(ARCHIVE_COLLECTION_NAME)
        bpy.context.scene.collection.children.link(archive)
    archive.hide_render = True
    archive.hide_viewport = True

    body_template = bpy.data.objects.get(BODY_TEMPLATE_NAME)
    current_body = bpy.data.objects.get(ORIGINAL_BODY_NAME)
    if body_template is None:
        require(current_body is not None, "legacy physics body is missing")
        require(not bool(current_body.get("exact_source_geometry")), "weight template is missing on an already rebuilt file")
        current_body.name = BODY_TEMPLATE_NAME
        body_template = current_body
    elif current_body is not None and current_body is not body_template:
        require(bool(current_body.get("exact_source_geometry")), "unexpected duplicate physics body")
        old_mesh = current_body.data
        bpy.data.objects.remove(current_body, do_unlink=True)
        if old_mesh.users == 0:
            bpy.data.meshes.remove(old_mesh)

    tail_archive = bpy.data.objects.get(TAIL_ARCHIVE_NAME)
    current_tail = bpy.data.objects.get(ORIGINAL_TAIL_NAME)
    if tail_archive is None:
        require(current_tail is not None, "legacy procedural tail is missing")
        current_tail.name = TAIL_ARCHIVE_NAME
        tail_archive = current_tail
    elif current_tail is not None and current_tail is not tail_archive:
        old_mesh = current_tail.data
        bpy.data.objects.remove(current_tail, do_unlink=True)
        if old_mesh.users == 0:
            bpy.data.meshes.remove(old_mesh)

    for obj in (body_template, tail_archive):
        move_exclusively_to_collection(obj, archive)
        obj.parent = None
        obj.hide_render = True
        obj.hide_viewport = True
        obj["export_excluded"] = True
        try:
            obj.hide_set(True)
        except RuntimeError:
            pass

    return body_template, tail_archive, archive


def build_exact_source_mesh(
    source: bpy.types.Object,
    body_template: bpy.types.Object,
    armature: bpy.types.Object,
) -> tuple[bpy.types.Object, set[int]]:
    require(len(source.data.vertices) == EXPECTED_SOURCE_VERTICES,
            f"source vertex count changed: {len(source.data.vertices)}")
    require(len(source.data.polygons) == EXPECTED_SOURCE_POLYGONS,
            f"source polygon count changed: {len(source.data.polygons)}")
    require(len(body_template.data.vertices) == EXPECTED_BODY_VERTICES,
            f"body template vertex count changed: {len(body_template.data.vertices)}")
    assert_closed_manifold(source.data, "preserved source")

    exact_mesh = source.data.copy()
    exact_mesh.name = "Chameleon_Physics_OriginalData"
    exact_mesh.transform(source_to_rig_matrix(source, body_template))
    exact_mesh.update(calc_edges=True)

    require(len(exact_mesh.vertices) == EXPECTED_SOURCE_VERTICES,
            "source transform changed the vertex count")
    require(len(exact_mesh.polygons) == EXPECTED_SOURCE_POLYGONS,
            "source transform changed the polygon count")
    assert_closed_manifold(exact_mesh, "transformed source")

    exact_object = bpy.data.objects.new(OUTPUT_NAME, exact_mesh)
    exact_object.parent = armature
    exact_object.matrix_parent_inverse = Matrix.Identity(4)
    exact_object.matrix_local = Matrix.Identity(4)

    rig_collection = bpy.data.collections.get(RIG_COLLECTION_NAME)
    if rig_collection is None:
        rig_collection = bpy.data.collections.new(RIG_COLLECTION_NAME)
        bpy.context.scene.collection.children.link(rig_collection)
    rig_collection.objects.link(exact_object)

    material = next((slot.material for slot in body_template.material_slots if slot.material is not None), None)
    require(material is not None, "physics skin material is missing")
    exact_mesh.materials.clear()
    exact_mesh.materials.append(material)

    modifier = exact_object.modifiers.new("Chameleon_Physical_Armature", "ARMATURE")
    modifier.object = armature
    modifier.use_deform_preserve_volume = True

    groups_by_template_index: dict[int, bpy.types.VertexGroup] = {}
    groups_by_name: dict[str, bpy.types.VertexGroup] = {}
    for source_group in body_template.vertex_groups:
        destination_group = exact_object.vertex_groups.new(name=source_group.name)
        groups_by_template_index[source_group.index] = destination_group
        groups_by_name[source_group.name] = destination_group
    require("pelvis" in groups_by_name, "pelvis vertex group is missing")

    source_tree = kdtree.KDTree(EXPECTED_SOURCE_VERTICES)
    for source_index, vertex in enumerate(exact_mesh.vertices):
        source_tree.insert(vertex.co, source_index)
    source_tree.balance()

    mapped_source_indices: set[int] = set()
    maximum_distance = 0.0
    for body_vertex in body_template.data.vertices:
        _, source_index, distance = source_tree.find(body_vertex.co)
        maximum_distance = max(maximum_distance, distance)
        require(distance <= MAPPING_TOLERANCE,
                f"body vertex {body_vertex.index} misses source by {distance:.9g}")
        require(source_index not in mapped_source_indices,
                f"source vertex {source_index} received two body mappings")
        mapped_source_indices.add(source_index)
        require(len(body_vertex.groups) > 0, f"body vertex {body_vertex.index} has no skin weight")
        weight_sum = 0.0
        for membership in body_vertex.groups:
            destination_group = groups_by_template_index.get(membership.group)
            require(destination_group is not None,
                    f"body vertex {body_vertex.index} references unknown group {membership.group}")
            destination_group.add([source_index], membership.weight, "REPLACE")
            weight_sum += membership.weight
        require(abs(weight_sum - 1.0) <= 2e-4,
                f"body vertex {body_vertex.index} weights sum to {weight_sum:.9g}")

    require(len(mapped_source_indices) == EXPECTED_BODY_VERTICES,
            f"mapped {len(mapped_source_indices)} body vertices instead of {EXPECTED_BODY_VERTICES}")
    require(maximum_distance <= MAPPING_TOLERANCE,
            f"maximum body mapping distance is {maximum_distance:.9g}")

    tail_indices = set(range(EXPECTED_SOURCE_VERTICES)) - mapped_source_indices
    require(len(tail_indices) == EXPECTED_TAIL_VERTICES,
            f"detected {len(tail_indices)} original tail vertices instead of {EXPECTED_TAIL_VERTICES}")
    groups_by_name["pelvis"].add(sorted(tail_indices), 1.0, "REPLACE")

    # Verify the final skin contract directly on Blender's authoritative data.
    for vertex in exact_mesh.vertices:
        require(len(vertex.groups) > 0, f"rebuilt vertex {vertex.index} has no skin weight")
        total = sum(membership.weight for membership in vertex.groups)
        require(abs(total - 1.0) <= 2e-4,
                f"rebuilt vertex {vertex.index} weights sum to {total:.9g}")
        if vertex.index in tail_indices:
            memberships = [(exact_object.vertex_groups[item.group].name, item.weight) for item in vertex.groups]
            require(len(memberships) == 1 and memberships[0][0] == "pelvis"
                    and abs(memberships[0][1] - 1.0) <= 1e-6,
                    f"tail vertex {vertex.index} is not rigidly bound to pelvis")

    exact_object["physics_ready"] = True
    exact_object["mesh_contract_version"] = "3.0.0"
    exact_object["source_object"] = SOURCE_NAME
    exact_object["exact_source_geometry"] = True
    exact_object["source_vertex_count"] = EXPECTED_SOURCE_VERTICES
    exact_object["source_polygon_count"] = EXPECTED_SOURCE_POLYGONS
    exact_object["original_tail_vertices"] = EXPECTED_TAIL_VERTICES
    exact_object["tail_deformation_mode"] = "rigid_pelvis"
    exact_object["tail_physics_dofs"] = 0
    exact_object["origin_normalized"] = True
    exact_object["origin_shift"] = list(body_template["origin_shift"])

    return exact_object, tail_indices


def update_armature_contract(armature: bpy.types.Object) -> None:
    armature["rig_version"] = "3.0.0"
    armature["physics_proxy_bodies"] = 1
    armature["runtime_controller"] = "hybrid-root-ik"
    armature["visual_bones"] = len(armature.data.bones)
    armature["coordinate_contract"] = "head=-X tail=+X up=+Z Blender; glTF Y-up"
    armature["source_model"] = SOURCE_NAME
    armature["render_mesh_count"] = 1
    armature["exact_source_geometry"] = True
    armature["original_tail_vertices"] = EXPECTED_TAIL_VERTICES
    armature["tail_deformation_mode"] = "rigid_pelvis"
    armature["tail_physics_dofs"] = 0


def export_selected_asset(armature: bpy.types.Object, exact_object: bpy.types.Object) -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if TEMP_OUTPUT_PATH.exists():
        TEMP_OUTPUT_PATH.unlink()

    for obj in bpy.context.scene.objects:
        try:
            obj.select_set(False)
        except RuntimeError:
            pass
    armature.hide_viewport = False
    armature.hide_render = False
    exact_object.hide_viewport = False
    exact_object.hide_render = False
    armature.select_set(True)
    exact_object.select_set(True)
    bpy.context.view_layer.objects.active = armature

    result = bpy.ops.export_scene.gltf(
        filepath=str(TEMP_OUTPUT_PATH),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_skins=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    require(result == {"FINISHED"}, f"glTF export returned {result}")
    require(TEMP_OUTPUT_PATH.is_file() and TEMP_OUTPUT_PATH.stat().st_size > 250_000,
            "temporary GLB was not written or is unexpectedly small")

    payload = TEMP_OUTPUT_PATH.read_bytes()
    require(len(payload) >= 20, "temporary GLB header is truncated")
    magic, version, declared_length = struct.unpack_from("<III", payload, 0)
    require(magic == 0x46546C67 and version == 2, "temporary output is not a GLB 2.0 asset")
    require(declared_length == len(payload), "temporary GLB declared length is invalid")
    json_length, json_type = struct.unpack_from("<II", payload, 12)
    require(json_type == 0x4E4F534A, "temporary GLB first chunk is not JSON")
    gltf = json.loads(payload[20:20 + json_length].decode("utf8").rstrip(" \x00"))
    require(len(gltf.get("meshes", [])) == 1, "export must contain exactly one render mesh")
    require(len(gltf.get("skins", [])) == 1, "export must contain exactly one skin")
    mesh_nodes = [node for node in gltf.get("nodes", []) if "mesh" in node]
    require(len(mesh_nodes) == 1 and mesh_nodes[0].get("name") == OUTPUT_NAME,
            "exported mesh node contract is invalid")
    require(len(gltf["skins"][0].get("joints", [])) == len(armature.data.bones),
            "exported skin lost armature bones")

    os.replace(TEMP_OUTPUT_PATH, OUTPUT_PATH)


def main() -> None:
    require(Path(bpy.data.filepath).resolve() == BLEND_PATH.resolve(),
            f"open blend must be {BLEND_PATH}, got {bpy.data.filepath}")
    source = require_object(SOURCE_NAME, "MESH")
    armature = require_object(ARMATURE_NAME, "ARMATURE")
    require(len(armature.data.bones) == 43,
            f"armature bone count changed: {len(armature.data.bones)}")

    body_template, _, _ = archive_legacy_objects()
    exact_object, tail_indices = build_exact_source_mesh(source, body_template, armature)
    require(len(tail_indices) == EXPECTED_TAIL_VERTICES, "tail contract changed after rebuild")
    update_armature_contract(armature)

    export_selected_asset(armature, exact_object)
    # The tracked .blend is reproducible from the preserved source and this
    # script.  Avoid leaving an untracked `.blend1` backup beside it.
    bpy.context.preferences.filepaths.save_version = 0
    result = bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), check_existing=False)
    require(result == {"FINISHED"}, f"saving blend returned {result}")

    print(
        "CHAMELEON_HYBRID_REBUILD_OK",
        json.dumps({
            "blend": str(BLEND_PATH),
            "glb": str(OUTPUT_PATH),
            "vertices": EXPECTED_SOURCE_VERTICES,
            "polygons": EXPECTED_SOURCE_POLYGONS,
            "mapped_body_vertices": EXPECTED_BODY_VERTICES,
            "rigid_original_tail_vertices": EXPECTED_TAIL_VERTICES,
            "tail_physics_dofs": 0,
        }, sort_keys=True),
    )


if __name__ == "__main__":
    try:
        main()
    finally:
        if TEMP_OUTPUT_PATH.exists():
            TEMP_OUTPUT_PATH.unlink()
