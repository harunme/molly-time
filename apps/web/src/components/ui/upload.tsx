import * as React from "react";
import { UploadCloud } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function FileUpload({
  children,
  accept,
  disabled,
  multiple = false,
  className,
  onFileSelect,
  onFilesSelect,
  inputId,
  inputTestId,
  inputLabel,
  ...props
}: Omit<React.ComponentProps<"div">, "onChange"> & {
  accept?: string;
  disabled?: boolean;
  multiple?: boolean;
  onFileSelect?: (file: File) => void;
  onFilesSelect?: (files: File[]) => void;
  inputId?: string;
  inputTestId?: string;
  inputLabel?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const select = (fileList?: FileList | File[]) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    const selectedFiles = multiple ? files : files.slice(0, 1);
    onFilesSelect?.(selectedFiles);
    onFileSelect?.(selectedFiles[0]);
  };
  return (
    <div
      role="button"
      data-slot="file-upload"
      tabIndex={disabled ? -1 : 0}
      data-dragging={dragging || undefined}
      aria-disabled={disabled}
      className={cn("cursor-pointer rounded-ui bg-muted hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring data-[dragging]:bg-success-surface", disabled && "cursor-not-allowed opacity-50", className)}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!disabled) inputRef.current?.click();
        }
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) select(event.dataTransfer.files);
      }}
      {...props}
    >
      <Input
        ref={inputRef}
        id={inputId}
        data-testid={inputTestId}
        aria-label={inputLabel}
        type="file"
        accept={accept}
        disabled={disabled}
        multiple={multiple}
        className="sr-only !h-0.25 !w-0.25 !min-w-0 !overflow-hidden !p-0"
        onChange={(event) => {
          select(event.target.files ?? undefined);
          event.target.value = "";
        }}
      />
      {children}
    </div>
  );
}

/** Compact file field using the same upload behavior and control tokens. */
function FileUploadField({ fileName, placeholder = "选择文件", className, ...props }:
  Omit<React.ComponentProps<typeof FileUpload>, "children"> & { fileName?: string; placeholder?: string; }) {
  return <FileUpload {...props} className={cn("flex h-control min-w-0 items-center gap-3 bg-card px-3 text-base hover:bg-surface-subtle", className)}>
    <UploadCloud className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <span className="min-w-0 flex-1 truncate" title={fileName}>{fileName || placeholder}</span>
    <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">浏览</span>
  </FileUpload>;
}

export { FileUpload, FileUploadField };
