import { describe, expect, it } from "vitest";
import { refusalOf } from "#src/community/goals";

type Case = readonly [pg: Record<string, unknown>, expected: unknown];

/** Every SQLSTATE refusalOf handles with the DETAIL, HINT and constraint variants it reads, and others it does not. */
const CASES: readonly Case[] = [
  [{ code: "AN404" }, { kind: "not_found" }],
  [{ code: "AN404", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "unlock" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "unlock", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "goal" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "goal", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "goal_overlap" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "goal_overlap", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "goal_locked" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "goal_locked", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "goal_started" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "goal_started", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "event_ended" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "event_ended", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "goal_limit" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "goal_limit", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "unlock_taken" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "unlock_taken", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "unknown_detail" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "unknown_detail", hint: "h1" }, { kind: "not_found" }],
  [{ code: "AN404" }, { kind: "not_found" }],
  [{ code: "AN404", detail: "unlock", hint: "unlock_counted" }, { kind: "not_found" }],
  [{ code: "AN404", constraint: "" }, { kind: "not_found" }],
  [
    { code: "AN404", detail: "unlock", hint: "unlock_counted", constraint: "" },
    { kind: "not_found" },
  ],
  [{ code: "AN404", constraint: "community_step_unlock_target_fkey" }, { kind: "not_found" }],
  [
    {
      code: "AN404",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    { kind: "not_found" },
  ],
  [{ code: "AN404", constraint: "community_goal_quest_fkey" }, { kind: "not_found" }],
  [
    {
      code: "AN404",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_quest_fkey",
    },
    { kind: "not_found" },
  ],
  [{ code: "AN404", constraint: "community_goal_category_fkey" }, { kind: "not_found" }],
  [
    {
      code: "AN404",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    { kind: "not_found" },
  ],
  [{ code: "AN404", constraint: "other_key" }, { kind: "not_found" }],
  [
    { code: "AN404", detail: "unlock", hint: "unlock_counted", constraint: "other_key" },
    { kind: "not_found" },
  ],
  [{ code: "GN404" }, { kind: "not_found" }],
  [{ code: "GN404", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "unlock" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "unlock", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "goal" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "goal", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "goal_overlap" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "goal_overlap", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "goal_locked" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "goal_locked", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "goal_started" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "goal_started", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "event_ended" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "event_ended", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "goal_limit" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "goal_limit", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "unlock_taken" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "unlock_taken", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "unknown_detail" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "unknown_detail", hint: "h1" }, { kind: "not_found" }],
  [{ code: "GN404" }, { kind: "not_found" }],
  [{ code: "GN404", detail: "unlock", hint: "unlock_counted" }, { kind: "not_found" }],
  [{ code: "GN404", constraint: "" }, { kind: "not_found" }],
  [
    { code: "GN404", detail: "unlock", hint: "unlock_counted", constraint: "" },
    { kind: "not_found" },
  ],
  [{ code: "GN404", constraint: "community_step_unlock_target_fkey" }, { kind: "not_found" }],
  [
    {
      code: "GN404",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    { kind: "not_found" },
  ],
  [{ code: "GN404", constraint: "community_goal_quest_fkey" }, { kind: "not_found" }],
  [
    {
      code: "GN404",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_quest_fkey",
    },
    { kind: "not_found" },
  ],
  [{ code: "GN404", constraint: "community_goal_category_fkey" }, { kind: "not_found" }],
  [
    {
      code: "GN404",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    { kind: "not_found" },
  ],
  [{ code: "GN404", constraint: "other_key" }, { kind: "not_found" }],
  [
    { code: "GN404", detail: "unlock", hint: "unlock_counted", constraint: "other_key" },
    { kind: "not_found" },
  ],
  [{ code: "CG422" }, { kind: "invalid", issues: ["goal"] }],
  [
    { code: "CG422", hint: "h1" },
    { kind: "invalid", issues: ["goal"] },
  ],
  [
    { code: "CG422", detail: "" },
    { kind: "invalid", issues: [""] },
  ],
  [
    { code: "CG422", detail: "", hint: "h1" },
    { kind: "invalid", issues: [""] },
  ],
  [
    { code: "CG422", detail: "unlock" },
    { kind: "invalid", issues: ["unlock"] },
  ],
  [
    { code: "CG422", detail: "unlock", hint: "h1" },
    { kind: "invalid", issues: ["h1"] },
  ],
  [
    { code: "CG422", detail: "goal" },
    { kind: "invalid", issues: ["goal"] },
  ],
  [
    { code: "CG422", detail: "goal", hint: "h1" },
    { kind: "invalid", issues: ["goal"] },
  ],
  [
    { code: "CG422", detail: "goal_overlap" },
    { kind: "invalid", issues: ["goal_overlap"] },
  ],
  [
    { code: "CG422", detail: "goal_overlap", hint: "h1" },
    { kind: "invalid", issues: ["goal_overlap"] },
  ],
  [
    { code: "CG422", detail: "goal_locked" },
    { kind: "invalid", issues: ["goal_locked"] },
  ],
  [
    { code: "CG422", detail: "goal_locked", hint: "h1" },
    { kind: "invalid", issues: ["goal_locked"] },
  ],
  [
    { code: "CG422", detail: "goal_started" },
    { kind: "invalid", issues: ["goal_started"] },
  ],
  [
    { code: "CG422", detail: "goal_started", hint: "h1" },
    { kind: "invalid", issues: ["goal_started"] },
  ],
  [
    { code: "CG422", detail: "event_ended" },
    { kind: "invalid", issues: ["event_ended"] },
  ],
  [
    { code: "CG422", detail: "event_ended", hint: "h1" },
    { kind: "invalid", issues: ["event_ended"] },
  ],
  [
    { code: "CG422", detail: "goal_limit" },
    { kind: "invalid", issues: ["goal_limit"] },
  ],
  [
    { code: "CG422", detail: "goal_limit", hint: "h1" },
    { kind: "invalid", issues: ["goal_limit"] },
  ],
  [
    { code: "CG422", detail: "unlock_taken" },
    { kind: "invalid", issues: ["unlock_taken"] },
  ],
  [
    { code: "CG422", detail: "unlock_taken", hint: "h1" },
    { kind: "invalid", issues: ["unlock_taken"] },
  ],
  [
    { code: "CG422", detail: "unknown_detail" },
    { kind: "invalid", issues: ["unknown_detail"] },
  ],
  [
    { code: "CG422", detail: "unknown_detail", hint: "h1" },
    { kind: "invalid", issues: ["unknown_detail"] },
  ],
  [{ code: "CG422" }, { kind: "invalid", issues: ["goal"] }],
  [
    { code: "CG422", detail: "unlock", hint: "unlock_counted" },
    { kind: "invalid", issues: ["unlock_counted"] },
  ],
  [
    { code: "CG422", constraint: "" },
    { kind: "invalid", issues: ["goal"] },
  ],
  [
    { code: "CG422", detail: "unlock", hint: "unlock_counted", constraint: "" },
    { kind: "invalid", issues: ["unlock_counted"] },
  ],
  [
    { code: "CG422", constraint: "community_step_unlock_target_fkey" },
    { kind: "invalid", issues: ["goal"] },
  ],
  [
    {
      code: "CG422",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    { kind: "invalid", issues: ["unlock_counted"] },
  ],
  [
    { code: "CG422", constraint: "community_goal_quest_fkey" },
    { kind: "invalid", issues: ["goal"] },
  ],
  [
    {
      code: "CG422",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_quest_fkey",
    },
    { kind: "invalid", issues: ["unlock_counted"] },
  ],
  [
    { code: "CG422", constraint: "community_goal_category_fkey" },
    { kind: "invalid", issues: ["goal"] },
  ],
  [
    {
      code: "CG422",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    { kind: "invalid", issues: ["unlock_counted"] },
  ],
  [
    { code: "CG422", constraint: "other_key" },
    { kind: "invalid", issues: ["goal"] },
  ],
  [
    { code: "CG422", detail: "unlock", hint: "unlock_counted", constraint: "other_key" },
    { kind: "invalid", issues: ["unlock_counted"] },
  ],
  [{ code: "GL409" }, null],
  [{ code: "GL409", hint: "h1" }, null],
  [{ code: "GL409", detail: "" }, null],
  [{ code: "GL409", detail: "", hint: "h1" }, null],
  [{ code: "GL409", detail: "unlock" }, null],
  [{ code: "GL409", detail: "unlock", hint: "h1" }, null],
  [{ code: "GL409", detail: "goal" }, null],
  [{ code: "GL409", detail: "goal", hint: "h1" }, null],
  [{ code: "GL409", detail: "goal_overlap" }, { kind: "overlap" }],
  [{ code: "GL409", detail: "goal_overlap", hint: "h1" }, { kind: "overlap" }],
  [
    { code: "GL409", detail: "goal_locked" },
    { kind: "locked", field: "goal" },
  ],
  [
    { code: "GL409", detail: "goal_locked", hint: "h1" },
    { kind: "locked", field: "h1" },
  ],
  [{ code: "GL409", detail: "goal_started" }, { kind: "started" }],
  [{ code: "GL409", detail: "goal_started", hint: "h1" }, { kind: "started" }],
  [{ code: "GL409", detail: "event_ended" }, { kind: "event_ended" }],
  [{ code: "GL409", detail: "event_ended", hint: "h1" }, { kind: "event_ended" }],
  [
    { code: "GL409", detail: "goal_limit" },
    { kind: "limit_reached", limit: 20 },
  ],
  [
    { code: "GL409", detail: "goal_limit", hint: "h1" },
    { kind: "limit_reached", limit: 20 },
  ],
  [{ code: "GL409", detail: "unlock_taken" }, { kind: "unlock_taken" }],
  [{ code: "GL409", detail: "unlock_taken", hint: "h1" }, { kind: "unlock_taken" }],
  [{ code: "GL409", detail: "unknown_detail" }, null],
  [{ code: "GL409", detail: "unknown_detail", hint: "h1" }, null],
  [{ code: "GL409" }, null],
  [{ code: "GL409", detail: "unlock", hint: "unlock_counted" }, null],
  [{ code: "GL409", constraint: "" }, null],
  [{ code: "GL409", detail: "unlock", hint: "unlock_counted", constraint: "" }, null],
  [{ code: "GL409", constraint: "community_step_unlock_target_fkey" }, null],
  [
    {
      code: "GL409",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    null,
  ],
  [{ code: "GL409", constraint: "community_goal_quest_fkey" }, null],
  [
    {
      code: "GL409",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_quest_fkey",
    },
    null,
  ],
  [{ code: "GL409", constraint: "community_goal_category_fkey" }, null],
  [
    {
      code: "GL409",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    null,
  ],
  [{ code: "GL409", constraint: "other_key" }, null],
  [{ code: "GL409", detail: "unlock", hint: "unlock_counted", constraint: "other_key" }, null],
  [{ code: "CO403" }, { kind: "owner_only" }],
  [{ code: "CO403", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "unlock" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "unlock", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "goal" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "goal", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "goal_overlap" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "goal_overlap", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "goal_locked" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "goal_locked", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "goal_started" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "goal_started", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "event_ended" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "event_ended", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "goal_limit" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "goal_limit", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "unlock_taken" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "unlock_taken", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "unknown_detail" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "unknown_detail", hint: "h1" }, { kind: "owner_only" }],
  [{ code: "CO403" }, { kind: "owner_only" }],
  [{ code: "CO403", detail: "unlock", hint: "unlock_counted" }, { kind: "owner_only" }],
  [{ code: "CO403", constraint: "" }, { kind: "owner_only" }],
  [
    { code: "CO403", detail: "unlock", hint: "unlock_counted", constraint: "" },
    { kind: "owner_only" },
  ],
  [{ code: "CO403", constraint: "community_step_unlock_target_fkey" }, { kind: "owner_only" }],
  [
    {
      code: "CO403",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    { kind: "owner_only" },
  ],
  [{ code: "CO403", constraint: "community_goal_quest_fkey" }, { kind: "owner_only" }],
  [
    {
      code: "CO403",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_quest_fkey",
    },
    { kind: "owner_only" },
  ],
  [{ code: "CO403", constraint: "community_goal_category_fkey" }, { kind: "owner_only" }],
  [
    {
      code: "CO403",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    { kind: "owner_only" },
  ],
  [{ code: "CO403", constraint: "other_key" }, { kind: "owner_only" }],
  [
    { code: "CO403", detail: "unlock", hint: "unlock_counted", constraint: "other_key" },
    { kind: "owner_only" },
  ],
  [{ code: "CS409" }, { kind: "settling" }],
  [{ code: "CS409", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409", detail: "" }, { kind: "settling" }],
  [{ code: "CS409", detail: "", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409", detail: "unlock" }, { kind: "settling" }],
  [{ code: "CS409", detail: "unlock", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409", detail: "goal" }, { kind: "settling" }],
  [{ code: "CS409", detail: "goal", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409", detail: "goal_overlap" }, { kind: "settling" }],
  [{ code: "CS409", detail: "goal_overlap", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409", detail: "goal_locked" }, { kind: "settling" }],
  [{ code: "CS409", detail: "goal_locked", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409", detail: "goal_started" }, { kind: "settling" }],
  [{ code: "CS409", detail: "goal_started", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409", detail: "event_ended" }, { kind: "settling" }],
  [{ code: "CS409", detail: "event_ended", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409", detail: "goal_limit" }, { kind: "settling" }],
  [{ code: "CS409", detail: "goal_limit", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409", detail: "unlock_taken" }, { kind: "settling" }],
  [{ code: "CS409", detail: "unlock_taken", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409", detail: "unknown_detail" }, { kind: "settling" }],
  [{ code: "CS409", detail: "unknown_detail", hint: "h1" }, { kind: "settling" }],
  [{ code: "CS409" }, { kind: "settling" }],
  [{ code: "CS409", detail: "unlock", hint: "unlock_counted" }, { kind: "settling" }],
  [{ code: "CS409", constraint: "" }, { kind: "settling" }],
  [
    { code: "CS409", detail: "unlock", hint: "unlock_counted", constraint: "" },
    { kind: "settling" },
  ],
  [{ code: "CS409", constraint: "community_step_unlock_target_fkey" }, { kind: "settling" }],
  [
    {
      code: "CS409",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    { kind: "settling" },
  ],
  [{ code: "CS409", constraint: "community_goal_quest_fkey" }, { kind: "settling" }],
  [
    {
      code: "CS409",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_quest_fkey",
    },
    { kind: "settling" },
  ],
  [{ code: "CS409", constraint: "community_goal_category_fkey" }, { kind: "settling" }],
  [
    {
      code: "CS409",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    { kind: "settling" },
  ],
  [{ code: "CS409", constraint: "other_key" }, { kind: "settling" }],
  [
    { code: "CS409", detail: "unlock", hint: "unlock_counted", constraint: "other_key" },
    { kind: "settling" },
  ],
  [{ code: "23505" }, { kind: "invalid", issues: ["milestones"] }],
  [
    { code: "23505", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "unlock" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "unlock", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "goal" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "goal", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "goal_overlap" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "goal_overlap", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "goal_locked" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "goal_locked", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "goal_started" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "goal_started", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "event_ended" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "event_ended", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "goal_limit" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "goal_limit", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "unlock_taken" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "unlock_taken", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "unknown_detail" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "unknown_detail", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [{ code: "23505" }, { kind: "invalid", issues: ["milestones"] }],
  [
    { code: "23505", detail: "unlock", hint: "unlock_counted" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", constraint: "" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "unlock", hint: "unlock_counted", constraint: "" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [{ code: "23505", constraint: "community_step_unlock_target_fkey" }, { kind: "unlock_taken" }],
  [
    {
      code: "23505",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    { kind: "unlock_taken" },
  ],
  [
    { code: "23505", constraint: "community_goal_quest_fkey" },
    { kind: "invalid", issues: ["questId"] },
  ],
  [
    {
      code: "23505",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_quest_fkey",
    },
    { kind: "invalid", issues: ["questId"] },
  ],
  [
    { code: "23505", constraint: "community_goal_category_fkey" },
    { kind: "invalid", issues: ["categoryId"] },
  ],
  [
    {
      code: "23505",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    { kind: "invalid", issues: ["categoryId"] },
  ],
  [
    { code: "23505", constraint: "other_key" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23505", detail: "unlock", hint: "unlock_counted", constraint: "other_key" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [{ code: "23503" }, { kind: "invalid", issues: ["milestones"] }],
  [
    { code: "23503", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "unlock" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "unlock", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "goal" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "goal", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "goal_overlap" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "goal_overlap", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "goal_locked" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "goal_locked", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "goal_started" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "goal_started", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "event_ended" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "event_ended", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "goal_limit" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "goal_limit", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "unlock_taken" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "unlock_taken", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "unknown_detail" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "unknown_detail", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [{ code: "23503" }, { kind: "invalid", issues: ["milestones"] }],
  [
    { code: "23503", detail: "unlock", hint: "unlock_counted" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", constraint: "" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "unlock", hint: "unlock_counted", constraint: "" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", constraint: "community_step_unlock_target_fkey" },
    { kind: "invalid", issues: ["unlock_target"] },
  ],
  [
    {
      code: "23503",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    { kind: "invalid", issues: ["unlock_target"] },
  ],
  [
    { code: "23503", constraint: "community_goal_quest_fkey" },
    { kind: "invalid", issues: ["questId"] },
  ],
  [
    {
      code: "23503",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_quest_fkey",
    },
    { kind: "invalid", issues: ["questId"] },
  ],
  [
    { code: "23503", constraint: "community_goal_category_fkey" },
    { kind: "invalid", issues: ["categoryId"] },
  ],
  [
    {
      code: "23503",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    { kind: "invalid", issues: ["categoryId"] },
  ],
  [
    { code: "23503", constraint: "other_key" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23503", detail: "unlock", hint: "unlock_counted", constraint: "other_key" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [{ code: "23514" }, { kind: "invalid", issues: ["milestones"] }],
  [
    { code: "23514", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "unlock" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "unlock", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "goal" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "goal", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "goal_overlap" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "goal_overlap", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "goal_locked" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "goal_locked", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "goal_started" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "goal_started", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "event_ended" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "event_ended", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "goal_limit" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "goal_limit", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "unlock_taken" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "unlock_taken", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "unknown_detail" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "unknown_detail", hint: "h1" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [{ code: "23514" }, { kind: "invalid", issues: ["milestones"] }],
  [
    { code: "23514", detail: "unlock", hint: "unlock_counted" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", constraint: "" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "unlock", hint: "unlock_counted", constraint: "" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", constraint: "community_step_unlock_target_fkey" },
    { kind: "invalid", issues: ["unlock_target"] },
  ],
  [
    {
      code: "23514",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    { kind: "invalid", issues: ["unlock_target"] },
  ],
  [
    { code: "23514", constraint: "community_goal_quest_fkey" },
    { kind: "invalid", issues: ["questId"] },
  ],
  [
    {
      code: "23514",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_quest_fkey",
    },
    { kind: "invalid", issues: ["questId"] },
  ],
  [
    { code: "23514", constraint: "community_goal_category_fkey" },
    { kind: "invalid", issues: ["categoryId"] },
  ],
  [
    {
      code: "23514",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    { kind: "invalid", issues: ["categoryId"] },
  ],
  [
    { code: "23514", constraint: "other_key" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [
    { code: "23514", detail: "unlock", hint: "unlock_counted", constraint: "other_key" },
    { kind: "invalid", issues: ["milestones"] },
  ],
  [{ code: "XX000" }, null],
  [{ code: "XX000", hint: "h1" }, null],
  [{ code: "XX000", detail: "" }, null],
  [{ code: "XX000", detail: "", hint: "h1" }, null],
  [{ code: "XX000", detail: "unlock" }, null],
  [{ code: "XX000", detail: "unlock", hint: "h1" }, null],
  [{ code: "XX000", detail: "goal" }, null],
  [{ code: "XX000", detail: "goal", hint: "h1" }, null],
  [{ code: "XX000", detail: "goal_overlap" }, null],
  [{ code: "XX000", detail: "goal_overlap", hint: "h1" }, null],
  [{ code: "XX000", detail: "goal_locked" }, null],
  [{ code: "XX000", detail: "goal_locked", hint: "h1" }, null],
  [{ code: "XX000", detail: "goal_started" }, null],
  [{ code: "XX000", detail: "goal_started", hint: "h1" }, null],
  [{ code: "XX000", detail: "event_ended" }, null],
  [{ code: "XX000", detail: "event_ended", hint: "h1" }, null],
  [{ code: "XX000", detail: "goal_limit" }, null],
  [{ code: "XX000", detail: "goal_limit", hint: "h1" }, null],
  [{ code: "XX000", detail: "unlock_taken" }, null],
  [{ code: "XX000", detail: "unlock_taken", hint: "h1" }, null],
  [{ code: "XX000", detail: "unknown_detail" }, null],
  [{ code: "XX000", detail: "unknown_detail", hint: "h1" }, null],
  [{ code: "XX000" }, null],
  [{ code: "XX000", detail: "unlock", hint: "unlock_counted" }, null],
  [{ code: "XX000", constraint: "" }, null],
  [{ code: "XX000", detail: "unlock", hint: "unlock_counted", constraint: "" }, null],
  [{ code: "XX000", constraint: "community_step_unlock_target_fkey" }, null],
  [
    {
      code: "XX000",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    null,
  ],
  [{ code: "XX000", constraint: "community_goal_quest_fkey" }, null],
  [
    {
      code: "XX000",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_quest_fkey",
    },
    null,
  ],
  [{ code: "XX000", constraint: "community_goal_category_fkey" }, null],
  [
    {
      code: "XX000",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    null,
  ],
  [{ code: "XX000", constraint: "other_key" }, null],
  [{ code: "XX000", detail: "unlock", hint: "unlock_counted", constraint: "other_key" }, null],
  [{ code: "" }, null],
  [{ code: "", hint: "h1" }, null],
  [{ code: "", detail: "" }, null],
  [{ code: "", detail: "", hint: "h1" }, null],
  [{ code: "", detail: "unlock" }, null],
  [{ code: "", detail: "unlock", hint: "h1" }, null],
  [{ code: "", detail: "goal" }, null],
  [{ code: "", detail: "goal", hint: "h1" }, null],
  [{ code: "", detail: "goal_overlap" }, null],
  [{ code: "", detail: "goal_overlap", hint: "h1" }, null],
  [{ code: "", detail: "goal_locked" }, null],
  [{ code: "", detail: "goal_locked", hint: "h1" }, null],
  [{ code: "", detail: "goal_started" }, null],
  [{ code: "", detail: "goal_started", hint: "h1" }, null],
  [{ code: "", detail: "event_ended" }, null],
  [{ code: "", detail: "event_ended", hint: "h1" }, null],
  [{ code: "", detail: "goal_limit" }, null],
  [{ code: "", detail: "goal_limit", hint: "h1" }, null],
  [{ code: "", detail: "unlock_taken" }, null],
  [{ code: "", detail: "unlock_taken", hint: "h1" }, null],
  [{ code: "", detail: "unknown_detail" }, null],
  [{ code: "", detail: "unknown_detail", hint: "h1" }, null],
  [{ code: "" }, null],
  [{ code: "", detail: "unlock", hint: "unlock_counted" }, null],
  [{ code: "", constraint: "" }, null],
  [{ code: "", detail: "unlock", hint: "unlock_counted", constraint: "" }, null],
  [{ code: "", constraint: "community_step_unlock_target_fkey" }, null],
  [
    {
      code: "",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_step_unlock_target_fkey",
    },
    null,
  ],
  [{ code: "", constraint: "community_goal_quest_fkey" }, null],
  [
    { code: "", detail: "unlock", hint: "unlock_counted", constraint: "community_goal_quest_fkey" },
    null,
  ],
  [{ code: "", constraint: "community_goal_category_fkey" }, null],
  [
    {
      code: "",
      detail: "unlock",
      hint: "unlock_counted",
      constraint: "community_goal_category_fkey",
    },
    null,
  ],
  [{ code: "", constraint: "other_key" }, null],
  [{ code: "", detail: "unlock", hint: "unlock_counted", constraint: "other_key" }, null],
  [{}, null],
  [{ hint: "h1" }, null],
  [{ detail: "" }, null],
  [{ detail: "", hint: "h1" }, null],
  [{ detail: "unlock" }, null],
  [{ detail: "unlock", hint: "h1" }, null],
  [{ detail: "goal" }, null],
  [{ detail: "goal", hint: "h1" }, null],
  [{ detail: "goal_overlap" }, null],
  [{ detail: "goal_overlap", hint: "h1" }, null],
  [{ detail: "goal_locked" }, null],
  [{ detail: "goal_locked", hint: "h1" }, null],
  [{ detail: "goal_started" }, null],
  [{ detail: "goal_started", hint: "h1" }, null],
  [{ detail: "event_ended" }, null],
  [{ detail: "event_ended", hint: "h1" }, null],
  [{ detail: "goal_limit" }, null],
  [{ detail: "goal_limit", hint: "h1" }, null],
  [{ detail: "unlock_taken" }, null],
  [{ detail: "unlock_taken", hint: "h1" }, null],
  [{ detail: "unknown_detail" }, null],
  [{ detail: "unknown_detail", hint: "h1" }, null],
  [{}, null],
  [{ detail: "unlock", hint: "unlock_counted" }, null],
  [{ constraint: "" }, null],
  [{ detail: "unlock", hint: "unlock_counted", constraint: "" }, null],
  [{ constraint: "community_step_unlock_target_fkey" }, null],
  [
    { detail: "unlock", hint: "unlock_counted", constraint: "community_step_unlock_target_fkey" },
    null,
  ],
  [{ constraint: "community_goal_quest_fkey" }, null],
  [{ detail: "unlock", hint: "unlock_counted", constraint: "community_goal_quest_fkey" }, null],
  [{ constraint: "community_goal_category_fkey" }, null],
  [{ detail: "unlock", hint: "unlock_counted", constraint: "community_goal_category_fkey" }, null],
  [{ constraint: "other_key" }, null],
  [{ detail: "unlock", hint: "unlock_counted", constraint: "other_key" }, null],
];

describe("refusalOf (community goals), the database's refusals as results", () => {
  it.each(CASES)("answers %j as pinned", (pg, expected) => {
    expect(refusalOf(pg as never) ?? null).toEqual(expected);
  });

  it("answers nothing for a plain Error, an empty object and a thrown string", () => {
    expect(refusalOf(new Error("boom") as never)).toBeUndefined();
    expect(refusalOf({} as never)).toBeUndefined();
    expect(refusalOf("boom" as never)).toBeUndefined();
  });

  it("throws for a thrown null, as before", () => {
    expect(() => refusalOf(null as never)).toThrow(TypeError);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "never matches the inherited key %s as a GL409 detail",
    (detail) => {
      expect(refusalOf({ code: "GL409", detail })).toBeUndefined();
    },
  );
});
