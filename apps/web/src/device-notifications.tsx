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
        try {
          const notification = new Notification(message, {
            body: "打开 MollyTime 概览，查看观看状态。",
            tag: `mollytime-boot:${familyId}:${device.id}`,
          });
          notification.onclick = () => { window.focus(); notification.close(); };
        } catch { /* Page notifications still work where desktop notifications are unavailable. */ }
      }
    }
  }, [devices, familyId, supported]);
  if (!supported) return null;
  return <Button variant="ghost" className="brandbar-tv-link" disabled={permission === "granted"}
    title={permission === "denied" ? "浏览器通知被禁用，电视开机时仍会在页面内提醒。可在浏览器的网站设置中允许通知。" : "允许浏览器通知后，切换标签页也能收到电视开机提醒。"}
    onClick={async () => {
      if (Notification.permission === "denied") {
        toast("请在浏览器的网站设置中允许通知", { description: "页面内开机提醒已启用。" });
        return;
      }
      try { setPermission(await Notification.requestPermission()); }
      catch { toast("当前浏览器无法开启系统通知，页面内提醒仍然有效。"); }
    }}><Bell className="size-3.5" /><span>{permission === "granted" ? "开机通知已开启" : "开启开机通知"}</span></Button>;
}
