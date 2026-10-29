import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { useReminderData } from "./reminders";

type Device = NonNullable<ReturnType<typeof useReminderData>["devices"]>[number];

export function DeviceNotifications({ devices, familyId }: { devices?: Device[]; familyId: string }) {
  const previous = useRef<Map<string, Device> | undefined>(undefined);
  const supported = typeof Notification !== "undefined";
  const [permission, setPermission] = useState<NotificationPermission>(supported ? Notification.permission : "denied");
  useEffect(() => { previous.current = undefined; }, [familyId]);
  useEffect(() => {
    if (!devices) return;
    const before = previous.current;
    previous.current = new Map(devices.map((device) => [device.id, device]));
    // Establish a baseline on login; an already online TV is not a new boot.
    if (!before) return;
    for (const device of devices) {
      const old = before.get(device.id);
      if (!device.online) continue;
      const rebooted = !!device.bootId && device.bootId !== old?.bootId;
      const connected = !old?.online;
      if (!rebooted && !connected) continue;
      const message = `${device.name}${rebooted ? "已开机" : "已上线"}`;
      toast(message, { description: "可在概览查看观看状态。", duration: 10000 });
      if (supported && Notification.permission === "granted") {
        // Mobile browsers require persistent notifications through the worker.
        void (async () => {
          const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/manage/') : undefined;
          if (registration?.active) {
            await registration.showNotification(message, { body: '打开 MollyTime 概览，查看观看状态。', tag: `mollytime-boot:${familyId}:${device.id}`, icon: '/manage/icons/icon-192.png' });
          } else {
            const notification = new Notification(message, { body: '打开 MollyTime 概览，查看观看状态。', tag: `mollytime-boot:${familyId}:${device.id}` });
            notification.onclick = () => { window.focus(); notification.close(); };
          }
        })().catch(() => { /* The in-page reminder remains available. */ });
      }
    }
  }, [devices, familyId, supported]);
  if (!supported) return <Button variant="ghost" className="brandbar-tv-link" aria-label="页面内开机提醒" title="页面内开机提醒" onClick={() => toast("页面内开机提醒已启用", { description: "应用打开并联网时生效；锁屏或关闭应用后无法保证提醒。" })}><Bell className="size-3.5" /><span>页面内开机提醒</span></Button>;
  return <Button variant="ghost" className="brandbar-tv-link"
    aria-label={permission === "granted" ? "页面运行期间通知已开启" : "开启页面运行期间通知"}
    title="仅在应用打开并联网时检测电视开机；锁屏或关闭应用后无法保证提醒。"
    onClick={async () => {
      if (Notification.permission === "granted") {
        toast("页面运行期间通知已开启", { description: "仅在应用打开并联网时检测；锁屏或关闭应用后无法保证提醒。" });
        return;
      }
      if (Notification.permission === "denied") {
        toast("请在浏览器的网站设置中允许通知", { description: "页面内开机提醒已启用。" });
        return;
      }
      try { setPermission(await Notification.requestPermission()); toast("仅在应用打开并联网时检测电视开机", { description: "锁屏或关闭应用后无法保证提醒。" }); }
      catch { toast("当前浏览器无法开启系统通知，页面内提醒仍然有效。"); }
    }}><Bell className="size-3.5" /><span>{permission === "granted" ? "页面运行期间通知已开启" : "开启页面运行期间通知"}</span></Button>;
}
