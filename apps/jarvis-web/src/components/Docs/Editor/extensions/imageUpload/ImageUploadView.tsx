// React NodeView for the image node. Three states:
//   - `uploadingId` set, no `uploadError` -> skeleton placeholder
//   - `uploadingId` set, `uploadError` set -> error tile + retry
//   - otherwise -> regular <img> bound to attrs.src

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

export function ImageUploadView({ node, editor, selected }: NodeViewProps) {
  const src = String(node.attrs["src"] ?? "");
  const alt = String(node.attrs["alt"] ?? "");
  const title = String(node.attrs["title"] ?? "");
  const uploadingId = node.attrs["uploadingId"] as string | null;
  const uploadError = node.attrs["uploadError"] as string | null;

  const wrapperClass =
    "block-editor-image" +
    (selected ? " is-selected" : "") +
    (uploadingId ? " is-uploading" : "");

  if (uploadingId && uploadError) {
    return (
      <NodeViewWrapper className={wrapperClass + " is-error"} contentEditable={false}>
        <div className="block-editor-image-error" role="alert">
          <span className="block-editor-image-error-text">
            上传失败：{uploadError}
          </span>
          <button
            type="button"
            className="block-editor-image-retry"
            onClick={() => {
              editor
                .chain()
                .focus()
                .retryImageUpload(uploadingId)
                .run();
            }}
          >
            重试
          </button>
        </div>
      </NodeViewWrapper>
    );
  }

  if (uploadingId) {
    return (
      <NodeViewWrapper className={wrapperClass} contentEditable={false}>
        <div className="block-editor-image-skeleton" aria-busy>
          <span className="block-editor-image-spinner" aria-hidden />
          <span className="block-editor-image-skeleton-text">上传中…</span>
        </div>
      </NodeViewWrapper>
    );
  }

  if (!src) {
    return (
      <NodeViewWrapper className={wrapperClass + " is-empty"} contentEditable={false}>
        <div className="block-editor-image-empty">
          <span aria-hidden>🖼️</span>
          <span>拖拽图片或粘贴到此处</span>
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className={wrapperClass} contentEditable={false}>
      <img
        src={src}
        alt={alt}
        title={title || undefined}
        loading="lazy"
        draggable={false}
      />
    </NodeViewWrapper>
  );
}
