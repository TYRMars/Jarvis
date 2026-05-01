import { useAppStore } from "../../store/appStore";
import type { DocKind } from "../../types/frames";

/// Initial body skeletons for each DocKind. Used to seed the
/// draft when a doc is created from the "+ New" sidebar entry —
/// gives users a structural starting point instead of a blank
/// textarea, without prescribing too much.
///
/// Notes:
/// - Headings stay at H2 so the title element (the doc title) is
///   the only H1 in the rendered preview.
/// - Templates are short on purpose. Anything longer pushes users
///   into editing-by-deletion, which is worse than blank.
/// - Notes always start blank: free-form notes shouldn't be
///   funneled into a structure.
/// - Templates are picked by the active UI language so a Chinese
///   user gets Chinese headings; switching language later doesn't
///   rewrite an existing draft.

const TEMPLATES_EN: Record<DocKind, string> = {
  note: "",
  research: [
    "## Question",
    "",
    "_What are you trying to learn?_",
    "",
    "## Sources",
    "",
    "- ",
    "",
    "## Excerpts",
    "",
    "> ",
    "",
    "## Synthesis",
    "",
    "",
  ].join("\n"),
  report: [
    "## TL;DR",
    "",
    "_One paragraph someone can scan in 10 seconds._",
    "",
    "## What happened",
    "",
    "## What's next",
    "",
    "- [ ] ",
    "",
  ].join("\n"),
  design: [
    "## Context",
    "",
    "_What problem are we solving, for whom?_",
    "",
    "## Proposal",
    "",
    "## Tradeoffs",
    "",
    "## Open questions",
    "",
    "- ",
    "",
  ].join("\n"),
  guide: [
    "## Overview",
    "",
    "_What will the reader be able to do after this guide?_",
    "",
    "## Prerequisites",
    "",
    "- ",
    "",
    "## Steps",
    "",
    "1. ",
    "",
    "## Troubleshooting",
    "",
    "",
  ].join("\n"),
};

const TEMPLATES_ZH: Record<DocKind, string> = {
  note: "",
  research: [
    "## 问题",
    "",
    "_你想搞清楚什么？_",
    "",
    "## 资料",
    "",
    "- ",
    "",
    "## 摘录",
    "",
    "> ",
    "",
    "## 综述",
    "",
    "",
  ].join("\n"),
  report: [
    "## 摘要",
    "",
    "_一段话讲清楚，10 秒能扫完。_",
    "",
    "## 发生了什么",
    "",
    "## 下一步",
    "",
    "- [ ] ",
    "",
  ].join("\n"),
  design: [
    "## 背景",
    "",
    "_要解决谁的什么问题？_",
    "",
    "## 方案",
    "",
    "## 取舍",
    "",
    "## 待定",
    "",
    "- ",
    "",
  ].join("\n"),
  guide: [
    "## 概述",
    "",
    "_读完这篇之后读者能做什么？_",
    "",
    "## 前置条件",
    "",
    "- ",
    "",
    "## 步骤",
    "",
    "1. ",
    "",
    "## 排错",
    "",
    "",
  ].join("\n"),
};

/// Compatibility export: previous code imported this as a static
/// map of English strings. Keep the en table here for any consumer
/// that doesn't care about language.
export const KIND_TEMPLATES = TEMPLATES_EN;

export function templateForKind(kind: DocKind): string {
  // Read the active language *now* (at create time), not at module
  // load. We deliberately don't memoise — switching language between
  // doc creations should yield the new template.
  const lang = useAppStore.getState().lang;
  const table = lang === "zh" ? TEMPLATES_ZH : TEMPLATES_EN;
  return table[kind] ?? "";
}
