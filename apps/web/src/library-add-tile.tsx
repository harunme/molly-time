import { FolderPlus, Plus, UploadCloud } from 'lucide-react';
import { useRef } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu';

export function LibraryAddTile({ onCreate, onUpload, creating = false, uploading = false }: {
  onCreate?: () => void; onUpload?: () => void; creating?: boolean; uploading?: boolean;
}) {
  const creatingFolder = useRef(false);
  const content = <span className="desktop-add-cover"><span className="desktop-add-art"><Plus aria-hidden="true" /></span></span>;
  return <div className="desktop-add-tile">
    {onCreate && onUpload ? <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" className="desktop-add-trigger" aria-label="添加内容">{content}</button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} onCloseAutoFocus={event => {
        if (creatingFolder.current) {
          event.preventDefault();
          onCreate();
        }
        creatingFolder.current = false;
      }}>
        <DropdownMenuItem disabled={creating} onSelect={() => { creatingFolder.current = true; }}><FolderPlus aria-hidden="true" />{creating ? '正在新建…' : '新建文件夹'}</DropdownMenuItem>
        <DropdownMenuItem disabled={uploading} onSelect={onUpload}><UploadCloud aria-hidden="true" />{uploading ? '正在加入…' : '上传视频'}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu> : <div className="desktop-add-trigger">{content}</div>}
  </div>;
}
