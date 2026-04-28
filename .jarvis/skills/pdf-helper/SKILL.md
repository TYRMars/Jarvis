---
name: pdf-helper
description: Read, summarise, and extract structured data from PDF files the user references by path. Use when the user mentions a .pdf or asks to inspect one.
activation: both
keywords: [pdf, document, extract, summarise]
version: "0.1.0"
---

When the user mentions a PDF file:

1. Resolve the path (relative paths are relative to the workspace).
2. Use `fs.read` if the file is text-extractable; otherwise tell
   the user the file is binary / scanned and you can't extract text
   without an OCR tool.
3. For summarisation: a 5-bullet TL;DR plus a short "what to read
   next" pointer. Cite page numbers when you can.
4. For data extraction: ask the user once for the target schema
   (fields, types) before extracting. Don't guess — schema mistakes
   are expensive to undo.

Never invent page numbers or quote text you didn't actually see.
