"""Rebuild the physical chameleon from its preserved original geometry.

This script is intentionally executable in Blender background mode:

    blender --background blender/chameleon_physics_rig.blend \
        --python scripts/rebuild-chameleon-hybrid-asset.py

The original imported mesh is the geometric authority.  Body weights are
copied vertex-for-vertex from the former physics body.  The original curled
tail remains visually exact while a surface-geodesic parameterization binds it
smoothly to twelve rest bones following its real curled medial line.
"""

from __future__ import annotations

import hashlib
import heapq
import json
import math
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
TAIL_BONE_COUNT = 12
TAIL_CENTERLINE_POINT_COUNT = TAIL_BONE_COUNT + 1
TAIL_BONE_NAMES = tuple(f"tail_{index:02d}" for index in range(1, TAIL_BONE_COUNT + 1))
EXPECTED_REST_MESH_SHA256 = "1732a987975806e9e34a48e529347dfca2291e02b8b9c967b3a7ae18f6f2287c"
EXPECTED_TAIL_REST_SHA256 = "6b493bfe12b33cc1e7caba9884b4681ad9317f24ab4da3d14c12b8599a820bd1"

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


def mesh_rest_sha256(mesh: bpy.types.Mesh) -> str:
    digest = hashlib.sha256()
    digest.update(b"chameleon-rest-mesh-v1\0")
    digest.update(struct.pack("<II", len(mesh.vertices), len(mesh.polygons)))
    for vertex in mesh.vertices:
        digest.update(struct.pack("<3f", *vertex.co))
    for polygon in mesh.polygons:
        digest.update(struct.pack("<I", len(polygon.vertices)))
        for vertex_index in polygon.vertices:
            digest.update(struct.pack("<I", vertex_index))
    return digest.hexdigest()


def tail_rest_sha256(mesh: bpy.types.Mesh, tail_indices: set[int]) -> str:
    digest = hashlib.sha256()
    digest.update(b"chameleon-original-tail-rest-v1\0")
    digest.update(struct.pack("<I", len(tail_indices)))
    for vertex_index in sorted(tail_indices):
        digest.update(struct.pack("<I3f", vertex_index, *mesh.vertices[vertex_index].co))
    return digest.hexdigest()


def build_tail_geodesic_contract(
    mesh: bpy.types.Mesh,
    tail_indices: set[int],
) -> tuple[list[float], list[Vector], float, list[float], int]:
    """Parameterize the preserved tail without spatial shortcuts across its curl."""
    adjacency: list[list[tuple[int, float]]] = [[] for _ in mesh.vertices]
    interface_vertices: set[int] = set()
    for edge in mesh.edges:
        first, second = edge.vertices
        first_is_tail = first in tail_indices
        second_is_tail = second in tail_indices
        if first_is_tail and second_is_tail:
            length = (mesh.vertices[first].co - mesh.vertices[second].co).length
            require(length > 1e-9, f"tail edge {edge.index} has zero length")
            adjacency[first].append((second, length))
            adjacency[second].append((first, length))
        elif first_is_tail != second_is_tail:
            interface_vertices.add(first if first_is_tail else second)

    require(len(interface_vertices) >= 3,
            f"tail/body interface is undersampled: {len(interface_vertices)} vertices")
    distances = [math.inf] * len(mesh.vertices)
    pending: list[tuple[float, int]] = []
    for vertex_index in sorted(interface_vertices):
        distances[vertex_index] = 0.0
        heapq.heappush(pending, (0.0, vertex_index))

    while pending:
        distance, vertex_index = heapq.heappop(pending)
        if distance != distances[vertex_index]:
            continue
        for neighbour, edge_length in adjacency[vertex_index]:
            candidate = distance + edge_length
            if candidate < distances[neighbour]:
                distances[neighbour] = candidate
                heapq.heappush(pending, (candidate, neighbour))

    unreachable = [index for index in tail_indices if not math.isfinite(distances[index])]
    require(not unreachable, f"tail geodesic left {len(unreachable)} vertices unreachable")
    maximum_distance = max(distances[index] for index in tail_indices)
    require(0.5 <= maximum_distance <= 3.0,
            f"tail surface geodesic length is implausible: {maximum_distance:.9g}")

    ordered_tail = sorted(tail_indices)
    sigma = maximum_distance / (TAIL_BONE_COUNT * 1.8)

    def centroid(indices: list[int], target: float | None = None) -> Vector:
        require(indices, "tail centerline shell is empty")
        total = Vector()
        total_weight = 0.0
        for vertex_index in indices:
            weight = 1.0 if target is None else math.exp(
                -0.5 * ((distances[vertex_index] - target) / sigma) ** 2
            )
            total += mesh.vertices[vertex_index].co * weight
            total_weight += weight
        require(total_weight > 1e-9, "tail centerline shell has zero weight")
        return total / total_weight

    raw_points: list[Vector] = []
    for sample in range(TAIL_CENTERLINE_POINT_COUNT):
        target = maximum_distance * sample / TAIL_BONE_COUNT
        if sample == 0:
            point = centroid(sorted(interface_vertices))
        elif sample == TAIL_BONE_COUNT:
            terminal = [
                index for index in ordered_tail
                if distances[index] >= maximum_distance - sigma * 0.65
            ]
            point = centroid(terminal, maximum_distance)
        else:
            shell = [
                index for index in ordered_tail
                if abs(distances[index] - target) <= sigma * 2.5
            ]
            point = centroid(shell, target)
        raw_points.append(point)

    centerline = [raw_points[0]]
    for index in range(1, TAIL_CENTERLINE_POINT_COUNT - 1):
        centerline.append(
            raw_points[index - 1] * 0.15
            + raw_points[index] * 0.70
            + raw_points[index + 1] * 0.15
        )
    centerline.append(raw_points[-1])

    segment_lengths = [
        (centerline[index + 1] - centerline[index]).length
        for index in range(TAIL_BONE_COUNT)
    ]
    require(all(length >= 0.015 for length in segment_lengths),
            f"tail centerline contains a degenerate segment: {segment_lengths}")
    require(all(length <= 0.35 for length in segment_lengths),
            f"tail centerline contains an excessive segment: {segment_lengths}")
    rest_arc_length = sum(segment_lengths)
    require(0.45 <= rest_arc_length <= 2.5,
            f"tail rest centerline length is implausible: {rest_arc_length:.9g}")

    return distances, centerline, maximum_distance, segment_lengths, len(interface_vertices)


def reposition_tail_rest_bones(
    armature: bpy.types.Object,
    centerline: list[Vector],
) -> None:
    require(len(centerline) == TAIL_CENTERLINE_POINT_COUNT,
            "tail centerline must expose thirteen rest points")
    if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for obj in bpy.context.scene.objects:
        try:
            obj.select_set(False)
        except RuntimeError:
            pass
    armature.hide_viewport = False
    armature.hide_render = False
    try:
        armature.hide_set(False)
    except RuntimeError:
        pass
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    result = bpy.ops.object.mode_set(mode="EDIT")
    require(result == {"FINISHED"}, f"entering armature edit mode returned {result}")
    try:
        edit_bones = armature.data.edit_bones
        pelvis = edit_bones.get("pelvis")
        require(pelvis is not None, "pelvis edit bone is missing")
        previous = None
        for index, name in enumerate(TAIL_BONE_NAMES):
            bone = edit_bones.get(name)
            require(bone is not None, f"tail rest bone {name} is missing")
            bone.use_connect = False
            bone.parent = pelvis if previous is None else previous
            bone.head = centerline[index]
            bone.tail = centerline[index + 1]
            if previous is not None:
                bone.use_connect = True
            direction = (bone.tail - bone.head).normalized()
            roll_reference = Vector((0.0, 1.0, 0.0))
            if abs(direction.dot(roll_reference)) > 0.94:
                roll_reference = Vector((0.0, 0.0, 1.0))
            bone.align_roll(roll_reference)
            previous = bone
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")

    for index, name in enumerate(TAIL_BONE_NAMES):
        bone = armature.data.bones[name]
        require((bone.head_local - centerline[index]).length <= 1e-5,
                f"tail rest head {name} moved away from its centerline")
        require((bone.tail_local - centerline[index + 1]).length <= 1e-5,
                f"tail rest tail {name} moved away from its centerline")


def cubic_bspline_tail_weights(parameter: float) -> list[tuple[int, float]]:
    coordinate = max(0.0, min(1.0, parameter)) * (TAIL_BONE_COUNT - 1)
    base = math.floor(coordinate)
    fraction = coordinate - base
    one_minus = 1.0 - fraction
    basis = (
        one_minus ** 3 / 6.0,
        (3.0 * fraction ** 3 - 6.0 * fraction ** 2 + 4.0) / 6.0,
        (-3.0 * fraction ** 3 + 3.0 * fraction ** 2 + 3.0 * fraction + 1.0) / 6.0,
        fraction ** 3 / 6.0,
    )
    merged: dict[int, float] = {}
    for offset, weight in zip((-1, 0, 1, 2), basis):
        bone_index = max(0, min(TAIL_BONE_COUNT - 1, base + offset))
        merged[bone_index] = merged.get(bone_index, 0.0) + weight
    total = sum(merged.values())
    require(abs(total - 1.0) <= 1e-9, f"tail B-spline basis sums to {total:.9g}")
    return [(index, weight / total) for index, weight in sorted(merged.items()) if weight > 1e-9]


def bind_original_tail_smoothly(
    exact_object: bpy.types.Object,
    groups_by_name: dict[str, bpy.types.VertexGroup],
    tail_indices: set[int],
    distances: list[float],
    maximum_distance: float,
) -> None:
    tail_groups = []
    for name in TAIL_BONE_NAMES:
        group = groups_by_name.get(name)
        require(group is not None, f"tail vertex group {name} is missing")
        tail_groups.append(group)

    for vertex_index in sorted(tail_indices):
        parameter = distances[vertex_index] / maximum_distance
        weights = cubic_bspline_tail_weights(parameter)
        require(1 <= len(weights) <= 4,
                f"tail vertex {vertex_index} has {len(weights)} spline influences")
        for bone_index, weight in weights:
            tail_groups[bone_index].add([vertex_index], weight, "REPLACE")

    for vertex_index in tail_indices:
        vertex = exact_object.data.vertices[vertex_index]
        memberships = [
            (exact_object.vertex_groups[item.group].name, item.weight)
            for item in vertex.groups if item.weight > 1e-9
        ]
        require(1 <= len(memberships) <= 4,
                f"tail vertex {vertex_index} has an invalid influence count")
        require(all(name in TAIL_BONE_NAMES for name, _ in memberships),
                f"tail vertex {vertex_index} leaked outside the visual tail chain")
        require(abs(sum(weight for _, weight in memberships) - 1.0) <= 2e-4,
                f"tail vertex {vertex_index} weights are not normalized")


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
    rest_mesh_hash = mesh_rest_sha256(exact_mesh)
    require(rest_mesh_hash == EXPECTED_REST_MESH_SHA256,
            f"rest mesh fingerprint changed: {rest_mesh_hash}")
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
    tail_mesh_hash = tail_rest_sha256(exact_mesh, tail_indices)
    require(tail_mesh_hash == EXPECTED_TAIL_REST_SHA256,
            f"original tail rest fingerprint changed: {tail_mesh_hash}")
    distances, centerline, surface_geodesic_length, segment_lengths, interface_count = (
        build_tail_geodesic_contract(exact_mesh, tail_indices)
    )
    reposition_tail_rest_bones(armature, centerline)
    bind_original_tail_smoothly(
        exact_object,
        groups_by_name,
        tail_indices,
        distances,
        surface_geodesic_length,
    )

    # Verify the final skin contract directly on Blender's authoritative data.
    for vertex in exact_mesh.vertices:
        require(len(vertex.groups) > 0, f"rebuilt vertex {vertex.index} has no skin weight")
        total = sum(membership.weight for membership in vertex.groups)
        require(abs(total - 1.0) <= 2e-4,
                f"rebuilt vertex {vertex.index} weights sum to {total:.9g}")

    flattened_centerline = [coordinate for point in centerline for coordinate in point]
    rest_arc_length = sum(segment_lengths)
    exact_object["physics_ready"] = True
    exact_object["mesh_contract_version"] = "3.1.0"
    exact_object["source_object"] = SOURCE_NAME
    exact_object["exact_source_geometry"] = True
    exact_object["source_vertex_count"] = EXPECTED_SOURCE_VERTICES
    exact_object["source_polygon_count"] = EXPECTED_SOURCE_POLYGONS
    exact_object["rest_mesh_position_topology_sha256"] = rest_mesh_hash
    exact_object["original_tail_vertices"] = EXPECTED_TAIL_VERTICES
    exact_object["original_tail_rest_position_sha256"] = tail_mesh_hash
    exact_object["tail_deformation_mode"] = "surface-geodesic-bspline-12"
    exact_object["tail_weighting"] = "surface-geodesic-cubic-bspline"
    exact_object["tail_weighted_vertices"] = EXPECTED_TAIL_VERTICES
    exact_object["tail_weight_bones"] = TAIL_BONE_COUNT
    exact_object["tail_weight_max_influences"] = 4
    exact_object["tail_centerline_samples"] = TAIL_CENTERLINE_POINT_COUNT
    exact_object["tail_interface_vertices"] = interface_count
    exact_object["tail_surface_geodesic_length"] = surface_geodesic_length
    exact_object["tail_rest_arc_length"] = rest_arc_length
    exact_object["tail_rest_centerline"] = flattened_centerline
    exact_object["tail_rest_segment_lengths"] = segment_lengths
    exact_object["tail_rest_coordinate_space"] = "blender-rig-local-z-up"
    exact_object["tail_roll_reference"] = [0.0, 1.0, 0.0]
    exact_object["tail_physics_dofs"] = 0
    exact_object["origin_normalized"] = True
    exact_object["origin_shift"] = list(body_template["origin_shift"])

    return exact_object, tail_indices


def update_armature_contract(
    armature: bpy.types.Object,
    exact_object: bpy.types.Object,
) -> None:
    armature["rig_version"] = "3.1.0"
    armature["physics_proxy_bodies"] = 1
    armature["runtime_controller"] = "hybrid-root-ik"
    armature["visual_bones"] = len(armature.data.bones)
    armature["coordinate_contract"] = (
        "head=-X tail-root=+X original-curled up=+Z Blender; glTF Y-up"
    )
    armature["source_model"] = SOURCE_NAME
    armature["render_mesh_count"] = 1
    armature["exact_source_geometry"] = True
    armature["physics_proxy_bone"] = "pelvis"
    armature["visual_deformation_bones"] = len(armature.data.bones) - 1
    armature["tail_rest_bone_axis"] = "local +Y"

    # The former ragdoll metadata is intentionally retired.  Runtime physics
    # owns one pelvis/root proxy; every other bone is a deterministic visual
    # deformation target (IK or authored pose), including the curled tail.
    for bone in armature.data.bones:
        for legacy_key in (
            "collider",
            "limit_min_deg",
            "limit_max_deg",
            "swing_limit_deg",
            "twist_limit_deg",
        ):
            if legacy_key in bone:
                del bone[legacy_key]
        is_proxy = bone.name == "pelvis"
        bone["physics_body"] = is_proxy
        bone["physics_role"] = "root-proxy" if is_proxy else "visual-deformation"
        bone["joint"] = "proxy-root" if is_proxy else "fixed-visual"
        bone["rest_head_local"] = list(bone.head_local)
        bone["rest_tail_local"] = list(bone.tail_local)
        bone["rest_length"] = bone.length
        bone["rest_axis"] = "local +Y"
        if bone.name in TAIL_BONE_NAMES:
            bone["tail_rest_index"] = TAIL_BONE_NAMES.index(bone.name)
            bone["tail_deformation_only"] = True

    for key in (
        "rest_mesh_position_topology_sha256",
        "original_tail_vertices",
        "original_tail_rest_position_sha256",
        "tail_deformation_mode",
        "tail_weighting",
        "tail_weighted_vertices",
        "tail_weight_bones",
        "tail_weight_max_influences",
        "tail_centerline_samples",
        "tail_interface_vertices",
        "tail_surface_geodesic_length",
        "tail_rest_arc_length",
        "tail_rest_centerline",
        "tail_rest_segment_lengths",
        "tail_rest_coordinate_space",
        "tail_roll_reference",
        "tail_physics_dofs",
    ):
        value = exact_object[key]
        if not isinstance(value, (str, int, float, bool)):
            value = list(value)
        armature[key] = value


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
    update_armature_contract(armature, exact_object)

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
            "smooth_original_tail_vertices": EXPECTED_TAIL_VERTICES,
            "tail_rest_arc_length": exact_object["tail_rest_arc_length"],
            "tail_physics_dofs": 0,
        }, sort_keys=True),
    )


if __name__ == "__main__":
    try:
        main()
    finally:
        if TEMP_OUTPUT_PATH.exists():
            TEMP_OUTPUT_PATH.unlink()
