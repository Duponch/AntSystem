"""Export the worker and soldier ants from the currently open Blender scene.

Run through the local Blender MCP bridge:
    python tools/blender_exec.py --file tools/export_ant_castes.py

The source scene remains arranged for presentation.  Root object transforms are
temporarily neutralised only while exporting, then restored.  The exported
assets intentionally omit normals and UVs: AntSystem derives flat normals from
the animated VAT positions and does not sample ant textures.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import bpy
from io_scene_gltf2 import GLTF2_filter_action


WORKSPACE = Path(r"E:\Code\AntSystem")
PUBLIC = WORKSPACE / "public"
ARTIFACTS = WORKSPACE / "artifacts"
WORKER_OUT = PUBLIC / "AntWorkerRigged.glb"
SOLDIER_OUT = PUBLIC / "AntSoldierRigged.glb"

WORKER_RIG = "AntRig"
WORKER_MESH = "Node"
SOLDIER_RIG = "AntSoldierRig"
SOLDIER_MESH = "AntSoldier"

CLIP_RANGES = {
    "Walk": (1.0, 25.0),
    "Walk_Soldier": (1.0, 33.0),
    "Attack_Soldier": (1.0, 48.0),
}


def action_fcurves(action):
    """Yield each F-curve once from a Blender 4.4+/5.x layered action."""

    seen = set()
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                for fcurve in channelbag.fcurves:
                    pointer = fcurve.as_pointer()
                    if pointer not in seen:
                        seen.add(pointer)
                        yield fcurve


def close_loop(action, first_frame, last_frame):
    """Make the last keyed value equal the first and enable cyclic preview."""

    curves = list(action_fcurves(action))
    for fcurve in curves:
        first_value = fcurve.evaluate(first_frame)
        endpoint = None
        for key in fcurve.keyframe_points:
            if abs(key.co.x - last_frame) < 1e-4:
                endpoint = key
                break
        if endpoint is None:
            endpoint = fcurve.keyframe_points.insert(
                last_frame, first_value, options={"FAST"}
            )
        endpoint.co.y = first_value
        endpoint.handle_left.y = first_value
        endpoint.handle_right.y = first_value
        endpoint.interpolation = "BEZIER"
        endpoint.handle_left_type = "AUTO_CLAMPED"
        endpoint.handle_right_type = "AUTO_CLAMPED"

        cycles = [m for m in fcurve.modifiers if m.type == "CYCLES"]
        modifier = cycles[0] if cycles else fcurve.modifiers.new("CYCLES")
        modifier.mode_before = "REPEAT"
        modifier.mode_after = "REPEAT"
        for duplicate in cycles[1:]:
            fcurve.modifiers.remove(duplicate)
        fcurve.update()

    action.use_cyclic = True
    action.use_frame_range = True
    action.frame_start = first_frame
    action.frame_end = last_frame
    return len(curves)


def endpoint_matrix_error(rig, action, first_frame, last_frame):
    """Maximum absolute pose-matrix component difference at both loop ends."""

    scene = bpy.context.scene
    previous = rig.animation_data.action
    previous_frame = scene.frame_current
    previous_subframe = scene.frame_subframe
    matrices = {}
    try:
        rig.animation_data.action = action
        for frame in (first_frame, last_frame):
            scene.frame_set(int(frame))
            bpy.context.view_layer.update()
            matrices[frame] = {
                bone.name: tuple(value for row in bone.matrix for value in row)
                for bone in rig.pose.bones
            }
    finally:
        rig.animation_data.action = previous
        scene.frame_set(previous_frame, subframe=previous_subframe)
        bpy.context.view_layer.update()
    return max(
        abs(a - b)
        for bone_name in matrices[first_frame]
        for a, b in zip(
            matrices[first_frame][bone_name], matrices[last_frame][bone_name]
        )
    )


def add_clip_metadata(action, role, fps):
    first, last = CLIP_RANGES[action.name]
    action["antsystem_role"] = role
    action["antsystem_loop"] = True
    action["antsystem_fps"] = int(fps)
    action["antsystem_duration"] = float((last - first) / fps)


def remove_action_filter_properties():
    """Remove the temporary Blender 5 glTF action-filter properties."""

    if hasattr(bpy.types.Scene, "gltf_action_filter"):
        for scene in bpy.data.scenes:
            try:
                scene.gltf_action_filter.clear()
            except (AttributeError, ReferenceError):
                pass
        del bpy.types.Scene.gltf_action_filter

    if hasattr(bpy.types.Scene, "gltf_action_filter_active"):
        del bpy.types.Scene.gltf_action_filter_active


def install_action_filter(kept_actions):
    """Expose only ``kept_actions`` to Blender's ACTIONS exporter."""

    kept_names = {action.name for action in kept_actions}
    remove_action_filter_properties()
    bpy.types.Scene.gltf_action_filter = bpy.props.CollectionProperty(
        type=GLTF2_filter_action
    )
    bpy.types.Scene.gltf_action_filter_active = bpy.props.IntProperty(default=0)

    for scene in bpy.data.scenes:
        for action in bpy.data.actions:
            item = scene.gltf_action_filter.add()
            item.action = action
            item.keep = action.name in kept_names


def export_pair(rig_name, mesh_name, actions, filepath):
    """Export one armature/mesh pair and the requested actions only."""

    rig = bpy.data.objects[rig_name]
    mesh = bpy.data.objects[mesh_name]
    animation_data = rig.animation_data_create()

    old_active = bpy.context.view_layer.objects.active
    old_selected = list(bpy.context.selected_objects)
    old_action = animation_data.action
    old_transform = (
        rig.location.copy(),
        rig.rotation_euler.copy(),
        rig.scale.copy(),
    )
    try:
        install_action_filter(actions)
        if bpy.context.object and bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        bpy.ops.object.select_all(action="DESELECT")
        rig.select_set(True)
        mesh.select_set(True)
        bpy.context.view_layer.objects.active = rig

        # Presentation offsets/scales must never leak into the game asset.
        rig.location = (0.0, 0.0, 0.0)
        rig.rotation_euler = (0.0, 0.0, 0.0)
        rig.scale = (1.0, 1.0, 1.0)
        animation_data.action = actions[0]

        bpy.context.view_layer.update()
        bpy.ops.export_scene.gltf(
            filepath=str(filepath),
            check_existing=False,
            export_format="GLB",
            use_selection=True,
            export_yup=True,
            export_apply=False,
            export_texcoords=False,
            export_normals=False,
            export_tangents=False,
            export_materials="PLACEHOLDER",
            export_unused_images=False,
            export_unused_textures=False,
            export_vertex_color="NONE",
            export_all_vertex_colors=False,
            export_attributes=False,
            export_cameras=False,
            export_lights=False,
            export_animations=True,
            export_animation_mode="ACTIONS",
            export_action_filter=True,
            export_force_sampling=True,
            export_frame_range=False,
            export_frame_step=1,
            export_anim_slide_to_zero=True,
            export_optimize_animation_size=True,
            export_optimize_animation_keep_anim_armature=True,
            export_skins=True,
            export_morph=False,
            export_leaf_bone=False,
            export_extras=True,
            will_save_settings=False,
        )
    finally:
        try:
            remove_action_filter_properties()
        finally:
            animation_data.action = old_action
            rig.location = old_transform[0]
            rig.rotation_euler = old_transform[1]
            rig.scale = old_transform[2]
            bpy.ops.object.select_all(action="DESELECT")
            for obj in old_selected:
                if obj.name in bpy.data.objects:
                    obj.select_set(True)
            if old_active and old_active.name in bpy.data.objects:
                bpy.context.view_layer.objects.active = old_active
            bpy.context.view_layer.update()


scene = bpy.context.scene
fps = scene.render.fps / scene.render.fps_base
if abs(fps - 60.0) > 1e-6:
    raise RuntimeError(f"Expected the authored 60 fps scene, got {fps:g} fps")

PUBLIC.mkdir(parents=True, exist_ok=True)
ARTIFACTS.mkdir(parents=True, exist_ok=True)

source_path = Path(bpy.data.filepath)
if not source_path.exists():
    raise RuntimeError("The open Blender scene has not been saved")
backup_path = ARTIFACTS / "bestiaire_before_ant_game_export.blend"
if not backup_path.exists():
    shutil.copy2(source_path, backup_path)

worker_rig = bpy.data.objects[WORKER_RIG]
soldier_rig = bpy.data.objects[SOLDIER_RIG]
worker_walk = bpy.data.actions["Walk"]
soldier_walk = bpy.data.actions["Walk_Soldier"]
soldier_attack = bpy.data.actions["Attack_Soldier"]

loop_curve_counts = {
    "Walk": close_loop(worker_walk, *CLIP_RANGES["Walk"]),
    "Walk_Soldier": close_loop(
        soldier_walk, *CLIP_RANGES["Walk_Soldier"]
    ),
    "Attack_Soldier": close_loop(
        soldier_attack, *CLIP_RANGES["Attack_Soldier"]
    ),
}
add_clip_metadata(worker_walk, "worker_walk", fps)
add_clip_metadata(soldier_walk, "soldier_walk", fps)
add_clip_metadata(soldier_attack, "soldier_attack", fps)

# Persist only the intentional loop correction and metadata before temporary
# export tracks/transforms are created.
bpy.ops.wm.save_as_mainfile(filepath=str(source_path))

export_pair(WORKER_RIG, WORKER_MESH, [worker_walk], WORKER_OUT)
export_pair(
    SOLDIER_RIG,
    SOLDIER_MESH,
    [soldier_walk, soldier_attack],
    SOLDIER_OUT,
)

# Clear Blender's dirty flag after the temporary export state was restored.
bpy.ops.wm.save_as_mainfile(filepath=str(source_path))

endpoint_errors = {
    "Walk": endpoint_matrix_error(
        worker_rig, worker_walk, *CLIP_RANGES["Walk"]
    ),
    "Walk_Soldier": endpoint_matrix_error(
        soldier_rig, soldier_walk, *CLIP_RANGES["Walk_Soldier"]
    ),
    "Attack_Soldier": endpoint_matrix_error(
        soldier_rig, soldier_attack, *CLIP_RANGES["Attack_Soldier"]
    ),
}

result = {
    "source": str(source_path),
    "backup": str(backup_path),
    "fps": fps,
    "exports": {
        "worker": {
            "path": str(WORKER_OUT),
            "bytes": os.path.getsize(WORKER_OUT),
            "clips": ["Walk"],
        },
        "soldier": {
            "path": str(SOLDIER_OUT),
            "bytes": os.path.getsize(SOLDIER_OUT),
            "clips": ["Walk_Soldier", "Attack_Soldier"],
        },
    },
    "durations": {
        name: (last - first) / fps
        for name, (first, last) in CLIP_RANGES.items()
    },
    "loop_curve_counts": loop_curve_counts,
    "endpoint_matrix_errors": endpoint_errors,
}
