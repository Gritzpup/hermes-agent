#!/usr/bin/env python3
"""Browser Tool Module — thin wrapper that re-exports action functions and registers tools.

The implementation has been split into focused submodules:
- browser_utils: PATH discovery, config, environment helpers
- browser_state: shared mutable state (sessions, cleanup lock)
- browser_session: session lifecycle, cleanup, orphan reaping
- browser_local: local CLI backend, command execution
- browser_actions: core actions (navigate, click, type, scroll, etc.)
- browser_actions_media: screenshots, images, vision
- browser_actions_extra: hover, highlight, drag, select, upload, wait, viewport
"""

# Re-export all public action functions so existing imports keep working
from tools.browser_actions import (
    browser_navigate,
    browser_snapshot,
    browser_click,
    browser_type,
    browser_scroll,
    browser_back,
    browser_press,
    browser_console,
    _browser_eval,
    _camofox_eval,
    _maybe_start_recording,
    _maybe_stop_recording,
)
from tools.browser_actions_media import (
    browser_get_images,
    browser_vision,
    _cleanup_old_screenshots,
    _cleanup_old_recordings,
)
from tools.browser_actions_extra import (
    browser_hover,
    browser_highlight,
    browser_drag,
    browser_select,
    browser_upload,
    browser_wait,
    browser_get_html,
    browser_get_text,
    browser_set_viewport,
    browser_screenshot_full,
    browser_actions,
)
from tools.browser_session import (
    cleanup_browser,
    cleanup_all_browsers,
)

# Import schemas and register tools
def check_browser_requirements() -> bool:
    """
    Check if browser tool requirements are met.

    In **local mode** (no cloud provider configured): only the
    ``agent-browser`` CLI must be findable.

    In **cloud mode** (Browserbase, Browser Use, or Firecrawl): the CLI
    *and* the provider's required credentials must be present.

    Returns:
        True if all requirements are met, False otherwise
    """
    # Gurbridge backend — only needs the Gurbridge IDE, no agent-browser CLI
    if _is_gurbridge_mode():
        return True

    # Camofox backend — only needs the server URL, no agent-browser CLI
    if _is_camofox_mode():
        return True

    # The agent-browser CLI is always required
    try:
        browser_cmd = _find_agent_browser()
    except FileNotFoundError:
        return False

    # On Termux, the bare npx fallback is too fragile to treat as a satisfied
    # local browser dependency. Require a real install (global or local) so the
    # browser tool is not advertised as available when it will likely fail on
    # first use.
    if _requires_real_termux_browser_install(browser_cmd):
        return False

    # In cloud mode, also require provider credentials
    provider = _get_cloud_provider()
    if provider is not None and not provider.is_configured():
        return False

    return True


# ============================================================================
# Module Test
# ============================================================================

if __name__ == "__main__":
    """
    Simple test/demo when run directly
    """
    print("🌐 Browser Tool Module")
    print("=" * 40)

    _cp = _get_cloud_provider()
    mode = "local" if _cp is None else f"cloud ({_cp.provider_name()})"
    print(f"   Mode: {mode}")
    
    # Check requirements
    if check_browser_requirements():
        print("✅ All requirements met")
    else:
        print("❌ Missing requirements:")
        try:
            browser_cmd = _find_agent_browser()
            if _requires_real_termux_browser_install(browser_cmd):
                print("   - bare npx fallback found (insufficient on Termux local mode)")
                print(f"     Install: {_browser_install_hint()}")
        except FileNotFoundError:
            print("   - agent-browser CLI not found")
            print(f"     Install: {_browser_install_hint()}")
        if _cp is not None and not _cp.is_configured():
            print(f"   - {_cp.provider_name()} credentials not configured")
            print("   Tip: set browser.cloud_provider to 'local' to use free local mode instead")
    
    print("\n📋 Available Browser Tools:")
    for schema in BROWSER_TOOL_SCHEMAS:
        print(f"  🔹 {schema['name']}: {schema['description'][:60]}...")
    
    print("\n💡 Usage:")
    print("  from tools.browser_tool import browser_navigate, browser_snapshot")
    print("  result = browser_navigate('https://example.com', task_id='my_task')")
    print("  snapshot = browser_snapshot(task_id='my_task')")


# ---------------------------------------------------------------------------

BROWSER_TOOL_SCHEMAS = [
    {
        "name": "browser_navigate",
        "description": "Navigate to a URL in the browser. Initializes the session and loads the page. Must be called before other browser tools. For simple information retrieval, prefer web_search or web_extract (faster, cheaper). Use browser tools when you need to interact with a page (click, fill forms, dynamic content). Returns a compact page snapshot with interactive elements and ref IDs — no need to call browser_snapshot separately after navigating.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to navigate to (e.g., 'https://example.com')"
                }
            },
            "required": ["url"]
        }
    },
    {
        "name": "browser_snapshot",
        "description": "Get a text-based snapshot of the current page's accessibility tree. Returns interactive elements with ref IDs (like @e1, @e2) for browser_click and browser_type. full=false (default): compact view with interactive elements. full=true: complete page content. Snapshots over 8000 chars are truncated or LLM-summarized. Requires browser_navigate first. Note: browser_navigate already returns a compact snapshot — use this to refresh after interactions that change the page, or with full=true for complete content.",
        "parameters": {
            "type": "object",
            "properties": {
                "full": {
                    "type": "boolean",
                    "description": "If true, returns complete page content. If false (default), returns compact view with interactive elements only.",
                    "default": False
                }
            },
            "required": []
        }
    },
    {
        "name": "browser_click",
        "description": "Click on an element identified by its ref ID from the snapshot (e.g., '@e5'). The ref IDs are shown in square brackets in the snapshot output. Requires browser_navigate and browser_snapshot to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "The element reference from the snapshot (e.g., '@e5', '@e12')"
                }
            },
            "required": ["ref"]
        }
    },
    {
        "name": "browser_type",
        "description": "Type text into an input field identified by its ref ID. Clears the field first, then types the new text. Requires browser_navigate and browser_snapshot to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "The element reference from the snapshot (e.g., '@e3')"
                },
                "text": {
                    "type": "string",
                    "description": "The text to type into the field"
                }
            },
            "required": ["ref", "text"]
        }
    },
    {
        "name": "browser_scroll",
        "description": "Scroll the page in a direction. Use this to reveal more content that may be below or above the current viewport. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "direction": {
                    "type": "string",
                    "enum": ["up", "down"],
                    "description": "Direction to scroll"
                }
            },
            "required": ["direction"]
        }
    },
    {
        "name": "browser_back",
        "description": "Navigate back to the previous page in browser history. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "browser_press",
        "description": "Press a keyboard key. Useful for submitting forms (Enter), navigating (Tab), or keyboard shortcuts. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown')"
                }
            },
            "required": ["key"]
        }
    },
    {
        "name": "browser_get_images",
        "description": "Get a list of all images on the current page with their URLs and alt text. Useful for finding images to analyze with the vision tool. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "browser_vision",
        "description": "Take a screenshot of the current page and analyze it with vision AI. Use this when you need to visually understand what's on the page - especially useful for CAPTCHAs, visual verification challenges, complex layouts, or when the text snapshot doesn't capture important visual information. Returns both the AI analysis and a screenshot_path that you can share with the user by including MEDIA:<screenshot_path> in your response. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "What you want to know about the page visually. Be specific about what you're looking for."
                },
                "annotate": {
                    "type": "boolean",
                    "default": False,
                    "description": "If true, overlay numbered [N] labels on interactive elements. Each [N] maps to ref @eN for subsequent browser commands. Useful for QA and spatial reasoning about page layout."
                }
            },
            "required": ["question"]
        }
    },
    {
        "name": "browser_console",
        "description": "Get browser console output and JavaScript errors from the current page. Returns console.log/warn/error/info messages and uncaught JS exceptions. Use this to detect silent JavaScript errors, failed API calls, and application warnings. Requires browser_navigate to be called first. When 'expression' is provided, evaluates JavaScript in the page context and returns the result — use this for DOM inspection, reading page state, or extracting data programmatically.",
        "parameters": {
            "type": "object",
            "properties": {
                "clear": {
                    "type": "boolean",
                    "default": False,
                    "description": "If true, clear the message buffers after reading"
                },
                "expression": {
                    "type": "string",
                    "description": "JavaScript expression to evaluate in the page context. Runs in the browser like DevTools console — full access to DOM, window, document. Return values are serialized to JSON. Example: 'document.title' or 'document.querySelectorAll(\"a\").length'"
                }
            },
            "required": []
        }
    },
    {
        "name": "browser_hover",
        "description": "Hover the mouse over an element or coordinates. Essential for triggering dropdown menus, tooltips, and hover states. Provide either 'ref' (from snapshot) OR 'x' and 'y' coordinates. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "Element reference from snapshot (e.g., '@e5'). Use this OR x+y, not both."
                },
                "x": {
                    "type": "integer",
                    "description": "X coordinate on the screenshot. Use this OR ref, not both."
                },
                "y": {
                    "type": "integer",
                    "description": "Y coordinate on the screenshot. Use this OR ref, not both."
                }
            },
            "required": []
        }
    },
    {
        "name": "browser_highlight",
        "description": "Visually highlight an element on the page to show what the agent is currently looking at. Creates a colored border overlay and smooth-scrolls the element into view. Use before reading or interacting with an element to make your inspection process visible. Provide the 'ref' from snapshot.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "Element reference from snapshot (e.g., '@e5')."
                },
                "label": {
                    "type": "string",
                    "description": "Optional label to show on the highlight overlay (e.g., 'search button')."
                }
            },
            "required": ["ref"]
        }
    },
    {
        "name": "browser_drag",
        "description": "Drag from one set of coordinates to another. Useful for sliders, drag-and-drop uploads, reordering lists, and range selectors. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "start_x": {"type": "integer", "description": "Starting X coordinate"},
                "start_y": {"type": "integer", "description": "Starting Y coordinate"},
                "end_x": {"type": "integer", "description": "Ending X coordinate"},
                "end_y": {"type": "integer", "description": "Ending Y coordinate"}
            },
            "required": ["start_x", "start_y", "end_x", "end_y"]
        }
    },
    {
        "name": "browser_select",
        "description": "Select an option from a <select> dropdown by its ref ID and option value. Use this instead of browser_click for dropdown menus. Requires browser_navigate and browser_snapshot to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "The element reference from the snapshot (e.g., '@e3')"
                },
                "value": {
                    "type": "string",
                    "description": "The option value to select (e.g., 'en', 'usa', 'option-1')"
                }
            },
            "required": ["ref", "value"]
        }
    },
    {
        "name": "browser_upload",
        "description": "Upload a file to a file input element by its ref ID. The file must exist on the local filesystem. Requires browser_navigate and browser_snapshot to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "The element reference from the snapshot (e.g., '@e3')"
                },
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file to upload (e.g., '/tmp/document.pdf')"
                }
            },
            "required": ["ref", "file_path"]
        }
    },
    {
        "name": "browser_wait",
        "description": "Wait for a condition to be met on the page before proceeding. Essential for robust automation when dealing with loading states, AJAX requests, and dynamic content. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "condition_type": {
                    "type": "string",
                    "enum": ["selector", "text", "navigation"],
                    "description": "Type of condition to wait for: 'selector' (CSS selector becomes visible), 'text' (text appears on page), or 'navigation' (URL changes to contain a fragment)"
                },
                "condition_value": {
                    "type": "string",
                    "description": "The selector, text, or URL fragment to wait for. Examples: '#results', 'Submit successful', 'checkout/complete'"
                },
                "timeout": {
                    "type": "integer",
                    "default": 5000,
                    "description": "Maximum time to wait in milliseconds (default: 5000)"
                }
            },
            "required": ["condition_type", "condition_value"]
        }
    },
    {
        "name": "browser_get_html",
        "description": "Get the full HTML source of the current page. Useful for parsing structured data, extracting meta tags, or finding elements not in the accessibility snapshot. Returns up to 8000 chars (truncated if longer). Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "browser_get_text",
        "description": "Get the visible text content of a specific element by its ref ID. Useful for reading dynamic values, status messages, or extracted data. Requires browser_navigate and browser_snapshot to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "The element reference from the snapshot (e.g., '@e5')"
                }
            },
            "required": ["ref"]
        }
    },
    {
        "name": "browser_set_viewport",
        "description": "Set the browser viewport size (width x height in pixels). Useful for testing responsive designs, mobile layouts, or triggering breakpoint-specific behavior. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "width": {"type": "integer", "description": "Viewport width in pixels"},
                "height": {"type": "integer", "description": "Viewport height in pixels"}
            },
            "required": ["width", "height"]
        }
    },
    {
        "name": "browser_screenshot_full",
        "description": "Take a full-page screenshot (not just the visible viewport) and save it locally. Returns the file path which can be shared with the user via MEDIA:<path>. Useful for capturing entire pages, long documents, or complete layouts. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "browser_actions",
        "description": "Execute a sequence of browser actions in a single batch call. Much faster than calling individual tools for multi-step workflows. Each action is a dict with a 'type' key. Supported types: navigate, click, clickRef, type, typeRef, scroll, press, hover, hoverRef, drag, select, wait, evaluate. If any action fails, the sequence stops and returns the error with partial results. Requires browser_navigate to be called first.",
        "parameters": {
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "description": "List of action dictionaries. Example: [{\"type\": \"clickRef\", \"ref\": \"@e1\"}, {\"type\": \"typeRef\", \"ref\": \"@e2\", \"text\": \"hello\"}, {\"type\": \"press\", \"key\": \"Enter\"}]"
                }
            },
            "required": ["actions"]
        }
    },
]


# ============================================================================
# Utility Functions
# ============================================================================

# ---------------------------------------------------------------------------
from tools.registry import registry, tool_error

_BROWSER_SCHEMA_MAP = {s["name"]: s for s in BROWSER_TOOL_SCHEMAS}

registry.register(
    name="browser_navigate",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_navigate"],
    handler=lambda args, **kw: browser_navigate(url=args.get("url", ""), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="🌐",
)
registry.register(
    name="browser_snapshot",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_snapshot"],
    handler=lambda args, **kw: browser_snapshot(
        full=args.get("full", False), task_id=kw.get("task_id"), user_task=kw.get("user_task")),
    check_fn=check_browser_requirements,
    emoji="📸",
)
registry.register(
    name="browser_click",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_click"],
    handler=lambda args, **kw: browser_click(ref=args.get("ref", ""), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="👆",
)
registry.register(
    name="browser_type",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_type"],
    handler=lambda args, **kw: browser_type(ref=args.get("ref", ""), text=args.get("text", ""), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="⌨️",
)
registry.register(
    name="browser_scroll",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_scroll"],
    handler=lambda args, **kw: browser_scroll(direction=args.get("direction", "down"), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="📜",
)
registry.register(
    name="browser_back",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_back"],
    handler=lambda args, **kw: browser_back(task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="◀️",
)
registry.register(
    name="browser_press",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_press"],
    handler=lambda args, **kw: browser_press(key=args.get("key", ""), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="⌨️",
)

registry.register(
    name="browser_get_images",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_get_images"],
    handler=lambda args, **kw: browser_get_images(task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="🖼️",
)
registry.register(
    name="browser_vision",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_vision"],
    handler=lambda args, **kw: browser_vision(question=args.get("question", ""), annotate=args.get("annotate", False), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="👁️",
)
registry.register(
    name="browser_console",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_console"],
    handler=lambda args, **kw: browser_console(clear=args.get("clear", False), expression=args.get("expression"), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="🖥️",
)
registry.register(
    name="browser_hover",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_hover"],
    handler=lambda args, **kw: browser_hover(
        ref=args.get("ref"), x=args.get("x"), y=args.get("y"), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="👆",
)
registry.register(
    name="browser_highlight",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_highlight"],
    handler=lambda args, **kw: browser_highlight(
        ref=args.get("ref"), label=args.get("label"), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="🔦",
)
registry.register(
    name="browser_drag",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_drag"],
    handler=lambda args, **kw: browser_drag(
        start_x=args.get("start_x", 0), start_y=args.get("start_y", 0),
        end_x=args.get("end_x", 0), end_y=args.get("end_y", 0), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="✋",
)
registry.register(
    name="browser_select",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_select"],
    handler=lambda args, **kw: browser_select(
        ref=args.get("ref", ""), value=args.get("value", ""), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="🔽",
)
registry.register(
    name="browser_upload",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_upload"],
    handler=lambda args, **kw: browser_upload(
        ref=args.get("ref", ""), file_path=args.get("file_path", ""), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="📎",
)
registry.register(
    name="browser_wait",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_wait"],
    handler=lambda args, **kw: browser_wait(
        condition_type=args.get("condition_type", ""),
        condition_value=args.get("condition_value", ""),
        timeout=args.get("timeout", 5000),
        task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="⏳",
)
registry.register(
    name="browser_get_html",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_get_html"],
    handler=lambda args, **kw: browser_get_html(task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="📄",
)
registry.register(
    name="browser_get_text",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_get_text"],
    handler=lambda args, **kw: browser_get_text(
        ref=args.get("ref", ""), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="📝",
)
registry.register(
    name="browser_set_viewport",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_set_viewport"],
    handler=lambda args, **kw: browser_set_viewport(
        width=args.get("width", 1280), height=args.get("height", 720), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="📐",
)
registry.register(
    name="browser_screenshot_full",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_screenshot_full"],
    handler=lambda args, **kw: browser_screenshot_full(task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="📸",
)
registry.register(
    name="browser_actions",
    toolset="browser",
    schema=_BROWSER_SCHEMA_MAP["browser_actions"],
    handler=lambda args, **kw: browser_actions(
        actions=args.get("actions", []), task_id=kw.get("task_id")),
    check_fn=check_browser_requirements,
    emoji="⚡",
)
