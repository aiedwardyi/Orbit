import { File as FileIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { formatSize, type AttachedFile } from "@/lib/composer-attachments";
import { useI18n } from "@/lib/i18n";

/** No link and no preview: a PC without the file shows the same row. */
export function FileAttachmentRow({ file }: { file: AttachedFile }) {
  const { t } = useI18n();
  const size = file.size === undefined ? "" : formatSize(file.size);
  return (
    <div
      data-file-row
      aria-label={size ? t("chat.fileRow", { name: file.name, size }) : file.name}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/40 px-2.5 py-1.5 whitespace-nowrap"
    >
      <FileIcon size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{file.name}</span>
      {size && <span className="shrink-0 text-[11.5px] text-ink-secondary">{size}</span>}
    </div>
  );
}

export function FileAttachmentRows({ files, className }: { files: AttachedFile[]; className?: string }) {
  if (files.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {files.map((file, index) => (
        <FileAttachmentRow key={`${file.path}:${index}`} file={file} />
      ))}
    </div>
  );
}
