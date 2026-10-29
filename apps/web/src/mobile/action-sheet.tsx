import type { ReactNode } from 'react';
import { Folder } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody } from '../components/ui/dialog';

export type MobileAction = { label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; destructive?: boolean };
/** Touch actions are contextual sheets, not desktop menus with smaller hit targets. */
export function MobileActionSheet({ open, close, title, detail, image, quick = [], groups }: {
  open: boolean; close: () => void; title: string; detail: string; image?: string; quick?: MobileAction[]; groups: MobileAction[][];
}) {
  const select = (action: MobileAction) => { if (action.disabled) return; close(); action.onSelect(); };
  return <Dialog open={open} onOpenChange={value => { if (!value) close(); }}><DialogContent className="m-sheet m-action-sheet" showCloseButton={false}>
    <DialogHeader><span className="m-sheet-grabber" aria-hidden="true" /><div className="m-action-context"><span className="m-action-thumbnail"><Folder size={25} strokeWidth={1.3} />{image && <img key={image} src={image} alt="" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span><div><DialogTitle>{title}</DialogTitle><DialogDescription>{detail}</DialogDescription></div></div></DialogHeader>
    <DialogBody className="m-actions-body">
      {quick.length > 0 && <div className="m-quick-actions" style={{ gridTemplateColumns: `repeat(${quick.length}, minmax(0, 1fr))` }}>{quick.map(action => <button key={action.label} disabled={action.disabled} onClick={() => select(action)}>{action.icon}<span>{action.label}</span></button>)}</div>}
      {groups.filter(group => group.length).map((group, index) => <div key={index} className="m-action-group">{group.map(action => <button key={action.label} className={action.destructive ? 'destructive' : undefined} disabled={action.disabled} onClick={() => select(action)}><span>{action.label}</span>{action.icon}</button>)}</div>)}
    </DialogBody>
    <div className="m-action-footer"><button onClick={close}>取消</button></div>
  </DialogContent></Dialog>;
}
