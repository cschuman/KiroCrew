"""`PATCH /api/chat/slots/{slot}/mutes-opened` is a dashboard-user-only write.

The "mute sessions it opens" flag is the user's own decision: ``session_create``'s
contract forbids an agent opening already-silenced sessions, so no agent or MCP
route may set it. The slot-ownership fences stop a FOREIGN caller, but an app or
internal-agent caller writing to a slot it owns would still pass them -- a shipped
built-in app holding the ``/api/chat/slots/*`` grant could otherwise flip the flag
with no user action. The handler therefore requires positive dashboard-human
provenance (``is_dashboard_user`` and not ``internal_auth``) before any mutation.

It is shaped exactly like ``api_chat_slot_pin``: the live flag is set to the new
value, then the slot is persisted off-loop; every save path (the full line and
the empty-window merge of a message-less newborn) serializes the field straight
off the live slot, so the committed value reaches disk no matter which branch
runs. A concurrent dirty-slot flush that takes the transcript lock mid-save
serializes the already-flipped flag rather than resurrecting the old one. A
refused or raising save rolls the live flag back to the committed value (only
while it still holds this request's value) and marks the slot dirty so the next
flush reconverges; nothing is published on failure.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from kiro_crew.dashboard.chat_folders import api_chat_slot_mutes_opened
from kiro_crew.dashboard.state import _ChatSlot


def _make_app(
    state: MagicMock, *, declared_app: str = "", internal_auth: bool = False
) -> web.Application:
    app = web.Application()
    app["state"] = state

    @web.middleware
    async def _publish_identity(request: web.Request, handler):
        # Mirror token_auth_middleware: an app token publishes its name and is
        # not a dashboard user; the internal-secret (MCP/cron) transport carries
        # no app claim but sets internal_auth. A real dashboard user has an empty
        # app and is_dashboard_user True.
        request["app"] = declared_app
        request["user"] = "local-app"
        request["internal_auth"] = internal_auth
        request["is_dashboard_user"] = declared_app == "" and not internal_auth
        return await handler(request)

    app.middlewares.append(_publish_identity)
    app.router.add_patch("/api/chat/slots/{slot}/mutes-opened", api_chat_slot_mutes_opened)
    return app


def _state(slot: _ChatSlot) -> MagicMock:
    state = MagicMock()
    state._slots = {slot.key: slot}
    state.push_slot_patch = MagicMock()
    return state


def _owned_slot(key: str, app: str = "") -> _ChatSlot:
    slot = _ChatSlot(key)
    slot._app = app
    return slot


# All four ownership fences pass for a caller writing to a slot it owns, so these
# tests isolate the dashboard-user provenance gate on top of them.
def _pass_all_fences():
    return (
        patch("kiro_crew.dashboard.chat_folders.refuse_unattributable_caller", return_value=None),
        patch("kiro_crew.dashboard.chat_folders.member_slot_write_refused", return_value=None),
        patch("kiro_crew.dashboard.chat_folders.deny_app_slot_access", return_value=None),
        patch("kiro_crew.dashboard.chat_folders.app_owns_transcript", return_value=True),
        patch("kiro_crew.dashboard.chat_folders._effective_request_app", return_value=""),
    )


class TestMuteIsDashboardUserOnly:
    @pytest.mark.asyncio
    async def test_app_caller_owning_its_slot_is_refused(self) -> None:
        slot = _owned_slot("chat-1-100", app="auto-improvement")
        state = _state(slot)
        f1, f2, f3, f4, f5 = _pass_all_fences()
        with (
            f1,
            f2,
            f3,
            f4,
            f5,
            patch(
                "kiro_crew.dashboard.chat_folders.save_slot_off_loop", AsyncMock(return_value=True)
            ) as save,
        ):
            app = _make_app(state, declared_app="auto-improvement")
            async with TestClient(TestServer(app)) as client:
                resp = await client.patch(
                    "/api/chat/slots/chat-1-100/mutes-opened", json={"mutes_opened": True}
                )
                body = await resp.json()
        assert resp.status == 403
        assert body["code"] == "mutes_opened_user_only"
        assert slot.mutes_opened is False  # never mutated
        save.assert_not_called()

    @pytest.mark.asyncio
    async def test_internal_agent_caller_is_refused(self) -> None:
        slot = _owned_slot("chat-1-100")
        state = _state(slot)
        f1, f2, f3, f4, f5 = _pass_all_fences()
        with (
            f1,
            f2,
            f3,
            f4,
            f5,
            patch(
                "kiro_crew.dashboard.chat_folders.save_slot_off_loop", AsyncMock(return_value=True)
            ) as save,
        ):
            app = _make_app(state, internal_auth=True)
            async with TestClient(TestServer(app)) as client:
                resp = await client.patch(
                    "/api/chat/slots/chat-1-100/mutes-opened", json={"mutes_opened": True}
                )
                body = await resp.json()
        assert resp.status == 403
        assert body["code"] == "mutes_opened_user_only"
        assert slot.mutes_opened is False
        save.assert_not_called()

    @pytest.mark.asyncio
    async def test_dashboard_user_is_allowed(self) -> None:
        slot = _owned_slot("chat-1-100")
        state = _state(slot)
        f1, f2, f3, f4, f5 = _pass_all_fences()
        with (
            f1,
            f2,
            f3,
            f4,
            f5,
            patch(
                "kiro_crew.dashboard.chat_folders.save_slot_off_loop", AsyncMock(return_value=True)
            ) as save,
        ):
            app = _make_app(state)  # dashboard user: empty app, no internal_auth
            async with TestClient(TestServer(app)) as client:
                resp = await client.patch(
                    "/api/chat/slots/chat-1-100/mutes-opened", json={"mutes_opened": True}
                )
                body = await resp.json()
        assert resp.status == 200
        assert body == {"ok": True, "mutes_opened": True, "changed": True}
        assert slot.mutes_opened is True
        save.assert_awaited_once()


class TestMuteSetThenSave:
    @pytest.mark.asyncio
    async def test_live_flag_is_set_before_the_save_so_every_path_serializes_it(self) -> None:
        """The live flag must already hold the new value while the save runs, so
        the full line AND the empty-window merge (which both read the field
        straight off the live slot) persist the committed value -- and a flush
        that serializes the slot mid-save writes the new value, not ``prior``."""
        slot = _owned_slot("chat-1-100")  # prior = False
        state = _state(slot)
        observed: dict[str, object] = {}

        async def _fake_save(*args, **kwargs):
            # The live flag the save serializes from must already be the new
            # value; the staged-override param must be gone.
            observed["live_during_save"] = slot.mutes_opened
            observed["has_meta_overrides"] = "meta_overrides" in kwargs
            return True

        f1, f2, f3, f4, f5 = _pass_all_fences()
        with (
            f1,
            f2,
            f3,
            f4,
            f5,
            patch("kiro_crew.dashboard.chat_folders.save_slot_off_loop", _fake_save),
        ):
            app = _make_app(state)
            async with TestClient(TestServer(app)) as client:
                resp = await client.patch(
                    "/api/chat/slots/chat-1-100/mutes-opened", json={"mutes_opened": True}
                )
        assert resp.status == 200
        assert observed["live_during_save"] is True  # set BEFORE the save
        assert observed["has_meta_overrides"] is False  # staged override removed
        assert slot.mutes_opened is True
        state.push_slot_patch.assert_called_once_with("chat-1-100", ("mutes_opened",))

    @pytest.mark.asyncio
    async def test_raising_save_rolls_the_flag_back_marks_dirty_and_publishes_nothing(self) -> None:
        slot = _owned_slot("chat-1-100")  # prior = False
        state = _state(slot)
        f1, f2, f3, f4, f5 = _pass_all_fences()

        async def _boom(*args, **kwargs):
            raise RuntimeError("disk full")

        with (
            f1,
            f2,
            f3,
            f4,
            f5,
            patch("kiro_crew.dashboard.chat_folders.save_slot_off_loop", _boom),
        ):
            app = _make_app(state)
            async with TestClient(TestServer(app)) as client:
                resp = await client.patch(
                    "/api/chat/slots/chat-1-100/mutes-opened", json={"mutes_opened": True}
                )
                body = await resp.json()
        assert resp.status == 503
        assert body["code"] == "mutes_opened_save_failed"
        assert slot.mutes_opened is False  # rolled back to the committed value
        assert slot._dirty is True  # flush will reconverge
        state.push_slot_patch.assert_not_called()  # nothing published

    @pytest.mark.asyncio
    async def test_refused_save_rolls_back_and_answers_409(self) -> None:
        slot = _owned_slot("chat-1-100")  # prior = False
        state = _state(slot)
        f1, f2, f3, f4, f5 = _pass_all_fences()
        with (
            f1,
            f2,
            f3,
            f4,
            f5,
            patch(
                "kiro_crew.dashboard.chat_folders.save_slot_off_loop",
                AsyncMock(return_value=False),
            ),
        ):
            app = _make_app(state)
            async with TestClient(TestServer(app)) as client:
                resp = await client.patch(
                    "/api/chat/slots/chat-1-100/mutes-opened", json={"mutes_opened": True}
                )
                body = await resp.json()
        assert resp.status == 409
        assert body["code"] == "session_gone"
        assert slot.mutes_opened is False  # rolled back
        assert slot._dirty is True
        state.push_slot_patch.assert_not_called()
