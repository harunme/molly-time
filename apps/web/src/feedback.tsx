import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ConfirmOptions = {
  title?: string;
  description: string;
  confirmText?: string;
  detail?: { label: string; value: string; };
};
type Decision =
  | (ConfirmOptions & { kind: "confirm"; resolve: (value: boolean) => void; })
  | {
    kind: "text";
    description: string;
    initial: string;
    resolve: (value: string | null) => void;
  };
const pending: Decision[] = [];
let updated = () => { };
export function confirmAction(options: string | ConfirmOptions) {
  return new Promise<boolean>((resolve) => {
    pending.push({ kind: "confirm", ...(typeof options === "string" ? { description: options } : options), resolve });
    updated();
  });
}
export function promptText(description: string, initial: string) {
  return new Promise<string | null>((resolve) => {
    pending.push({ kind: "text", description, initial, resolve });
    updated();
  });
}
export function FeedbackDialogs() {
  const [, render] = useState(0),
    [text, setText] = useState("");
  const decision = pending[0];
  useEffect(() => {
    updated = () => render((value) => value + 1);
    return () => {
      updated = () => { };
    };
  }, []);
  useEffect(() => {
    setText(decision?.kind === "text" ? decision.initial : "");
  }, [decision]);
  const finish = (accepted: boolean) => {
    if (!decision) return;
    pending.shift();
    if (decision.kind === "text")
      decision.resolve(accepted ? text.trim() : null);
    else decision.resolve(accepted);
    render((value) => value + 1);
  };
  if (decision?.kind === "confirm") return <ConfirmDialog
    open onOpenChange={(open) => { if (!open) finish(false); }}
    title={decision.title || "确认操作"} description={decision.description}
    confirmLabel={decision.confirmText || "确认"} onConfirm={() => finish(true)}>
    {decision.detail && <div className="feedback-dialog-detail mt-3">
      <span>{decision.detail.label}</span><strong>{decision.detail.value}</strong>
    </div>}
  </ConfirmDialog>;
  return (
    <Dialog
      open={!!decision}
      onOpenChange={(open) => {
        if (!open) finish(false);
      }}
    >
      <DialogContent className="feedback-dialog" overlayClassName="feedback-dialog-overlay">
        <DialogHeader>
          <DialogTitle>
            {decision?.description || "修改名称"}
          </DialogTitle>
          <DialogDescription>
            输入新的名称，保存后立即生效。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            finish(true);
          }}
        >
          {decision?.kind === "text" && (
            <DialogBody>
              <Label>
                新名称
                <Input
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={128}
                  required
                />
              </Label>
            </DialogBody>
          )}
          <DialogFooter>
            <Button
              variant="bordered"
              type="button"
              onClick={() => finish(false)}
            >
              取消
            </Button>
            <Button type="submit">确认</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
