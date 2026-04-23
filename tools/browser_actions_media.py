"""Media actions — screenshots, images, vision, recording cleanup."""

import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

from agent.auxiliary_client import call_llm

from tools.browser_state import cleanup_lock, recording_sessions
from tools.browser_utils import (
    _get_cloud_provider,
    _get_vision_model,
    _is_gurbridge_mode,
    _is_camofox_mode,
    logger,
)
from tools.browser_local import _run_browser_command
from tools.browser_session import _get_session_info

def browser_get_images(task_id: Optional[str] = None) -> str:
    """
    Get all images on the current page.
    
    Args:
        task_id: Task identifier for session isolation
        
    Returns:
        JSON string with list of images (src and alt)
    """
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_get_images
        return gurbridge_get_images(task_id)

    if _is_camofox_mode():
        from tools.browser_camofox import camofox_get_images
        return camofox_get_images(task_id)

    effective_task_id = task_id or "default"
    
    # Use eval to run JavaScript that extracts images
    js_code = """JSON.stringify(
        [...document.images].map(img => ({
            src: img.src,
            alt: img.alt || '',
            width: img.naturalWidth,
            height: img.naturalHeight
        })).filter(img => img.src && !img.src.startsWith('data:'))
    )"""
    
    result = _run_browser_command(effective_task_id, "eval", [js_code])
    
    if result.get("success"):
        data = result.get("data", {})
        raw_result = data.get("result", "[]")
        
        try:
            # Parse the JSON string returned by JavaScript
            if isinstance(raw_result, str):
                images = json.loads(raw_result)
            else:
                images = raw_result
            
            return json.dumps({
                "success": True,
                "images": images,
                "count": len(images)
            }, ensure_ascii=False)
        except json.JSONDecodeError:
            return json.dumps({
                "success": True,
                "images": [],
                "count": 0,
                "warning": "Could not parse image data"
            }, ensure_ascii=False)
    else:
        return json.dumps({
            "success": False,
            "error": result.get("error", "Failed to get images")
        }, ensure_ascii=False)


def browser_vision(question: str, annotate: bool = False, task_id: Optional[str] = None) -> str:
    """
    Take a screenshot of the current page and analyze it with vision AI.
    
    This tool captures what's visually displayed in the browser and sends it
    to Gemini for analysis. Useful for understanding visual content that the
    text-based snapshot may not capture (CAPTCHAs, verification challenges,
    images, complex layouts, etc.).
    
    The screenshot is saved persistently and its file path is returned alongside
    the analysis, so it can be shared with users via MEDIA:<path> in the response.
    
    Args:
        question: What you want to know about the page visually
        annotate: If True, overlay numbered [N] labels on interactive elements
        task_id: Task identifier for session isolation
        
    Returns:
        JSON string with vision analysis results and screenshot_path
    """
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_vision
        return gurbridge_vision(question, annotate, task_id)

    if _is_camofox_mode():
        from tools.browser_camofox import camofox_vision
        return camofox_vision(question, annotate, task_id)

    import base64
    import uuid as uuid_mod
    effective_task_id = task_id or "default"
    
    # Save screenshot to persistent location so it can be shared with users
    from hermes_constants import get_hermes_dir
    screenshots_dir = get_hermes_dir("cache/screenshots", "browser_screenshots")
    screenshot_path = screenshots_dir / f"browser_screenshot_{uuid_mod.uuid4().hex}.png"
    
    try:
        screenshots_dir.mkdir(parents=True, exist_ok=True)
        
        # Prune old screenshots (older than 24 hours) to prevent unbounded disk growth
        _cleanup_old_screenshots(screenshots_dir, max_age_hours=24)
        
        # Take screenshot using agent-browser
        screenshot_args = []
        if annotate:
            screenshot_args.append("--annotate")
        screenshot_args.append("--full")
        screenshot_args.append(str(screenshot_path))
        result = _run_browser_command(
            effective_task_id, 
            "screenshot", 
            screenshot_args,
        )
        
        if not result.get("success"):
            error_detail = result.get("error", "Unknown error")
            _cp = _get_cloud_provider()
            mode = "local" if _cp is None else f"cloud ({_cp.provider_name()})"
            return json.dumps({
                "success": False,
                "error": f"Failed to take screenshot ({mode} mode): {error_detail}"
            }, ensure_ascii=False)

        actual_screenshot_path = result.get("data", {}).get("path")
        if actual_screenshot_path:
            screenshot_path = Path(actual_screenshot_path)

        # Check if screenshot file was created
        if not screenshot_path.exists():
            _cp = _get_cloud_provider()
            mode = "local" if _cp is None else f"cloud ({_cp.provider_name()})"
            return json.dumps({
                "success": False,
                "error": (
                    f"Screenshot file was not created at {screenshot_path} ({mode} mode). "
                    f"This may indicate a socket path issue (macOS /var/folders/), "
                    f"a missing Chromium install ('agent-browser install'), "
                    f"or a stale daemon process."
                ),
            }, ensure_ascii=False)
        
        # Convert screenshot to base64 at full resolution.
        _screenshot_bytes = screenshot_path.read_bytes()
        _screenshot_b64 = base64.b64encode(_screenshot_bytes).decode("ascii")
        data_url = f"data:image/png;base64,{_screenshot_b64}"
        
        vision_prompt = (
            f"You are analyzing a screenshot of a web browser.\n\n"
            f"User's question: {question}\n\n"
            f"Provide a detailed and helpful answer based on what you see in the screenshot. "
            f"If there are interactive elements, describe them. If there are verification challenges "
            f"or CAPTCHAs, describe what type they are and what action might be needed. "
            f"Focus on answering the user's specific question."
        )

        # Use the centralized LLM router
        vision_model = _get_vision_model()
        logger.debug("browser_vision: analysing screenshot (%d bytes)",
                     len(_screenshot_bytes))

        # Read vision timeout/temperature from config (auxiliary.vision.*).
        # Local vision models (llama.cpp, ollama) can take well over 30s for
        # screenshot analysis, so the default timeout must be generous.
        vision_timeout = 120.0
        vision_temperature = 0.1
        try:
            from hermes_cli.config import load_config
            _cfg = load_config()
            _vision_cfg = _cfg.get("auxiliary", {}).get("vision", {})
            _vt = _vision_cfg.get("timeout")
            if _vt is not None:
                vision_timeout = float(_vt)
            _vtemp = _vision_cfg.get("temperature")
            if _vtemp is not None:
                vision_temperature = float(_vtemp)
        except Exception:
            pass

        call_kwargs = {
            "task": "vision",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": vision_prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            "max_tokens": 2000,
            "temperature": vision_temperature,
            "timeout": vision_timeout,
        }
        if vision_model:
            call_kwargs["model"] = vision_model
        # Try full-size screenshot; on size-related rejection, downscale and retry.
        try:
            response = call_llm(**call_kwargs)
        except Exception as _api_err:
            from tools.vision_tools import (
                _is_image_size_error, _resize_image_for_vision, _RESIZE_TARGET_BYTES,
            )
            if (_is_image_size_error(_api_err)
                    and len(data_url) > _RESIZE_TARGET_BYTES):
                logger.info(
                    "Vision API rejected screenshot (%.1f MB); "
                    "auto-resizing to ~%.0f MB and retrying...",
                    len(data_url) / (1024 * 1024),
                    _RESIZE_TARGET_BYTES / (1024 * 1024),
                )
                data_url = _resize_image_for_vision(
                    screenshot_path, mime_type="image/png")
                call_kwargs["messages"][0]["content"][1]["image_url"]["url"] = data_url
                response = call_llm(**call_kwargs)
            else:
                raise
        
        analysis = (response.choices[0].message.content or "").strip()
        # Redact secrets the vision LLM may have read from the screenshot.
        from agent.redact import redact_sensitive_text
        analysis = redact_sensitive_text(analysis)
        response_data = {
            "success": True,
            "analysis": analysis or "Vision analysis returned no content.",
            "screenshot_path": str(screenshot_path),
        }
        # Include annotation data if annotated screenshot was taken
        if annotate and result.get("data", {}).get("annotations"):
            response_data["annotations"] = result["data"]["annotations"]
        return json.dumps(response_data, ensure_ascii=False)
    
    except Exception as e:
        # Keep the screenshot if it was captured successfully — the failure is
        # in the LLM vision analysis, not the capture.  Deleting a valid
        # screenshot loses evidence the user might need.  The 24-hour cleanup
        # in _cleanup_old_screenshots prevents unbounded disk growth.
        logger.warning("browser_vision failed: %s", e, exc_info=True)
        error_info = {"success": False, "error": f"Error during vision analysis: {str(e)}"}
        if screenshot_path.exists():
            error_info["screenshot_path"] = str(screenshot_path)
            error_info["note"] = "Screenshot was captured but vision analysis failed. You can still share it via MEDIA:<path>."
        return json.dumps(error_info, ensure_ascii=False)


def _cleanup_old_screenshots(screenshots_dir, max_age_hours=24):
    """Remove browser screenshots older than max_age_hours to prevent disk bloat.

    Throttled to run at most once per hour per directory to avoid repeated
    scans on screenshot-heavy workflows.
    """
    key = str(screenshots_dir)
    now = time.time()
    if now - _last_screenshot_cleanup_by_dir.get(key, 0.0) < 3600:
        return
    _last_screenshot_cleanup_by_dir[key] = now

    try:
        cutoff = time.time() - (max_age_hours * 3600)
        for f in screenshots_dir.glob("browser_screenshot_*.png"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
            except Exception as e:
                logger.debug("Failed to clean old screenshot %s: %s", f, e)
    except Exception as e:
        logger.debug("Screenshot cleanup error (non-critical): %s", e)


def _cleanup_old_recordings(max_age_hours=72):
    """Remove browser recordings older than max_age_hours to prevent disk bloat."""
    try:
        hermes_home = get_hermes_home()
        recordings_dir = hermes_home / "browser_recordings"
        if not recordings_dir.exists():
            return
        cutoff = time.time() - (max_age_hours * 3600)
        for f in recordings_dir.glob("session_*.webm"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
            except Exception as e:
                logger.debug("Failed to clean old recording %s: %s", f, e)
    except Exception as e:
        logger.debug("Recording cleanup error (non-critical): %s", e)


# ============================================================================
# Cleanup and Management Functions
