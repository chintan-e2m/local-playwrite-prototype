# Imported automatically by every Python process of a task (PYTHONPATH includes this folder).
# Redirects Playwright's chromium.launch() in the dev-command plugin's scripts to the task's
# browser on the developer machine (TEAMING_CDP_ENDPOINT, tunnelled by the Runner Hub).
import os

_endpoint = os.environ.get("TEAMING_CDP_ENDPOINT")
_CONTEXT_KEYS = ("viewport", "device_scale_factor", "user_agent", "locale", "timezone_id", "color_scheme",
                 "is_mobile", "has_touch", "java_script_enabled", "extra_http_headers", "ignore_https_errors",
                 "reduced_motion", "screen")

if _endpoint:
    try:
        from playwright.sync_api._generated import BrowserType as _SyncBrowserType

        def _launch(self, *args, **kwargs):
            return self.connect_over_cdp(_endpoint)

        def _launch_persistent(self, user_data_dir, *args, **kwargs):
            browser = self.connect_over_cdp(_endpoint)
            return browser.new_context(**{k: v for k, v in kwargs.items() if k in _CONTEXT_KEYS})

        _SyncBrowserType.launch = _launch
        _SyncBrowserType.launch_persistent_context = _launch_persistent
    except Exception:
        pass
    try:
        from playwright.async_api._generated import BrowserType as _AsyncBrowserType

        async def _alaunch(self, *args, **kwargs):
            return await self.connect_over_cdp(_endpoint)

        async def _alaunch_persistent(self, user_data_dir, *args, **kwargs):
            browser = await self.connect_over_cdp(_endpoint)
            return await browser.new_context(**{k: v for k, v in kwargs.items() if k in _CONTEXT_KEYS})

        _AsyncBrowserType.launch = _alaunch
        _AsyncBrowserType.launch_persistent_context = _alaunch_persistent
    except Exception:
        pass
