import { describe, expect, it } from "vitest";
import { deviceErrorOf } from "#src/devices/errors";
import { describeError, type Answer } from "#test/support/refusal-answer";

type Case = readonly [pg: Record<string, unknown>, expected: Answer];

/** Every SQLSTATE of migration 0057's doors with every DETAIL it reads and some it does not; "returned" is no answer. */
const CASES: readonly Case[] = [
  [
    { code: "DV401" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV401", detail: "" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV401", detail: "kind" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV401", detail: "label" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV401", detail: "event_closed" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV401", detail: "limit_reached" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV401", detail: "not_screen_qr" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV401", detail: "not_kiosk" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV401", detail: "wrong_kind" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV401", detail: "code_taken" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV401", detail: "unknown_detail" },
    {
      status: 401,
      code: "device_unpaired",
      message: "This screen isn't paired. Ask the event team to pair it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404", detail: "" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404", detail: "kind" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404", detail: "label" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404", detail: "event_closed" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404", detail: "limit_reached" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404", detail: "not_screen_qr" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404", detail: "not_kiosk" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404", detail: "wrong_kind" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404", detail: "code_taken" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV404", detail: "unknown_detail" },
    {
      status: 404,
      code: "unknown_code",
      message: "We couldn't find this code, or it expired. Get a new code from the screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404", detail: "" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404", detail: "kind" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404", detail: "label" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404", detail: "event_closed" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404", detail: "limit_reached" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404", detail: "not_screen_qr" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404", detail: "not_kiosk" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404", detail: "wrong_kind" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404", detail: "code_taken" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DN404", detail: "unknown_detail" },
    {
      status: 404,
      code: "unknown_device",
      message: "We couldn't find this device.",
      details: {},
      denied: false,
    },
  ],
  [{ code: "DV409" }, "returned"],
  [{ code: "DV409", detail: "" }, "returned"],
  [{ code: "DV409", detail: "kind" }, "returned"],
  [{ code: "DV409", detail: "label" }, "returned"],
  [
    { code: "DV409", detail: "event_closed" },
    {
      status: 409,
      code: "event_closed",
      message: "The event has ended, so no devices can be paired.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV409", detail: "limit_reached" },
    {
      status: 409,
      code: "limit_reached",
      message: "This event has reached its limit.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV409", detail: "not_screen_qr" },
    {
      status: 409,
      code: "not_screen_qr",
      message: "This quest doesn't use a QR on a screen.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV409", detail: "not_kiosk" },
    {
      status: 409,
      code: "not_kiosk",
      message: "This quest doesn't use a kiosk.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV409", detail: "wrong_kind" },
    {
      status: 409,
      code: "wrong_kind",
      message: "This screen is another kind of device. Open the right page on it.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV409", detail: "code_taken" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [{ code: "DV409", detail: "unknown_detail" }, "returned"],
  [
    { code: "DV422" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "kind" },
      denied: false,
    },
  ],
  [
    { code: "DV422", detail: "" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "" },
      denied: false,
    },
  ],
  [
    { code: "DV422", detail: "kind" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "kind" },
      denied: false,
    },
  ],
  [
    { code: "DV422", detail: "label" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "label" },
      denied: false,
    },
  ],
  [
    { code: "DV422", detail: "event_closed" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "event_closed" },
      denied: false,
    },
  ],
  [
    { code: "DV422", detail: "limit_reached" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "limit_reached" },
      denied: false,
    },
  ],
  [
    { code: "DV422", detail: "not_screen_qr" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "not_screen_qr" },
      denied: false,
    },
  ],
  [
    { code: "DV422", detail: "not_kiosk" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "not_kiosk" },
      denied: false,
    },
  ],
  [
    { code: "DV422", detail: "wrong_kind" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "wrong_kind" },
      denied: false,
    },
  ],
  [
    { code: "DV422", detail: "code_taken" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "code_taken" },
      denied: false,
    },
  ],
  [
    { code: "DV422", detail: "unknown_detail" },
    {
      status: 422,
      code: "invalid_device",
      message: "Check the device's details.",
      details: { field: "unknown_detail" },
      denied: false,
    },
  ],
  [
    { code: "DV503" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV503", detail: "" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV503", detail: "kind" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV503", detail: "label" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV503", detail: "event_closed" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV503", detail: "limit_reached" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV503", detail: "not_screen_qr" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV503", detail: "not_kiosk" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV503", detail: "wrong_kind" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV503", detail: "code_taken" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "DV503", detail: "unknown_detail" },
    {
      status: 503,
      code: "busy",
      message: "We're busy right now. Try again in a moment.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403", detail: "" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403", detail: "kind" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403", detail: "label" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403", detail: "event_closed" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403", detail: "limit_reached" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403", detail: "not_screen_qr" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403", detail: "not_kiosk" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403", detail: "wrong_kind" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403", detail: "code_taken" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OP403", detail: "unknown_detail" },
    {
      status: 403,
      code: "not_operator",
      message: "You are no longer an operator at this event.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403", detail: "" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403", detail: "kind" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403", detail: "label" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403", detail: "event_closed" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403", detail: "limit_reached" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403", detail: "not_screen_qr" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403", detail: "not_kiosk" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403", detail: "wrong_kind" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403", detail: "code_taken" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OA403", detail: "unknown_detail" },
    {
      status: 403,
      code: "ability_off",
      message: "The owner turned this off for you.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403", detail: "" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403", detail: "kind" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403", detail: "label" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403", detail: "event_closed" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403", detail: "limit_reached" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403", detail: "not_screen_qr" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403", detail: "not_kiosk" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403", detail: "wrong_kind" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403", detail: "code_taken" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OS403", detail: "unknown_detail" },
    {
      status: 403,
      code: "outside_quests",
      message: "This quest isn't one of yours.",
      details: {},
      denied: false,
    },
  ],
  [
    { code: "OQ404" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "OQ404", detail: "" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "OQ404", detail: "kind" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "OQ404", detail: "label" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "OQ404", detail: "event_closed" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "OQ404", detail: "limit_reached" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "OQ404", detail: "not_screen_qr" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "OQ404", detail: "not_kiosk" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "OQ404", detail: "wrong_kind" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "OQ404", detail: "code_taken" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "OQ404", detail: "unknown_detail" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404", detail: "" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404", detail: "kind" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404", detail: "label" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404", detail: "event_closed" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404", detail: "limit_reached" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404", detail: "not_screen_qr" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404", detail: "not_kiosk" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404", detail: "wrong_kind" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404", detail: "code_taken" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [
    { code: "AN404", detail: "unknown_detail" },
    { status: 404, code: "not_found", message: "Not found.", details: {}, denied: false },
  ],
  [{ code: "XX000" }, "returned"],
  [{ code: "XX000", detail: "" }, "returned"],
  [{ code: "XX000", detail: "kind" }, "returned"],
  [{ code: "XX000", detail: "label" }, "returned"],
  [{ code: "XX000", detail: "event_closed" }, "returned"],
  [{ code: "XX000", detail: "limit_reached" }, "returned"],
  [{ code: "XX000", detail: "not_screen_qr" }, "returned"],
  [{ code: "XX000", detail: "not_kiosk" }, "returned"],
  [{ code: "XX000", detail: "wrong_kind" }, "returned"],
  [{ code: "XX000", detail: "code_taken" }, "returned"],
  [{ code: "XX000", detail: "unknown_detail" }, "returned"],
  [{ code: "" }, "returned"],
  [{ code: "", detail: "" }, "returned"],
  [{ code: "", detail: "kind" }, "returned"],
  [{ code: "", detail: "label" }, "returned"],
  [{ code: "", detail: "event_closed" }, "returned"],
  [{ code: "", detail: "limit_reached" }, "returned"],
  [{ code: "", detail: "not_screen_qr" }, "returned"],
  [{ code: "", detail: "not_kiosk" }, "returned"],
  [{ code: "", detail: "wrong_kind" }, "returned"],
  [{ code: "", detail: "code_taken" }, "returned"],
  [{ code: "", detail: "unknown_detail" }, "returned"],
  [{}, "returned"],
  [{ detail: "" }, "returned"],
  [{ detail: "kind" }, "returned"],
  [{ detail: "label" }, "returned"],
  [{ detail: "event_closed" }, "returned"],
  [{ detail: "limit_reached" }, "returned"],
  [{ detail: "not_screen_qr" }, "returned"],
  [{ detail: "not_kiosk" }, "returned"],
  [{ detail: "wrong_kind" }, "returned"],
  [{ detail: "code_taken" }, "returned"],
  [{ detail: "unknown_detail" }, "returned"],
];

describe("deviceErrorOf, every door and detail", () => {
  it.each(CASES)("answers %j as pinned", (pg, expected) => {
    const error = deviceErrorOf(pg as never);
    expect(error === undefined ? "returned" : describeError(error)).toEqual(expected);
  });

  it("answers nothing for a plain Error and an empty object", () => {
    expect(deviceErrorOf(new Error("boom") as never)).toBeUndefined();
    expect(deviceErrorOf({} as never)).toBeUndefined();
  });

  it("throws for a thrown null, as before", () => {
    expect(() => deviceErrorOf(null as never)).toThrow(TypeError);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "never matches the inherited key %s as a DV409 detail",
    (detail) => {
      expect(deviceErrorOf({ code: "DV409", detail })).toBeUndefined();
    },
  );
});
