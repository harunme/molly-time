export const controlMotionClassName =
  "transition-[background-color,border-color,box-shadow,color,opacity,transform] duration-[var(--motion-duration-quick)] ease-[var(--motion-ease-standard)] motion-reduce:transition-none";

export const pressMotionClassName =
  `${controlMotionClassName} active:not-disabled:scale-[var(--motion-scale-press)] motion-reduce:active:not-disabled:scale-100`;

export const overlayMotionClassName =
  "data-[state=open]:animate-[ui-overlay-in_var(--motion-duration-fast)_var(--motion-ease-standard)] data-[state=closed]:animate-[ui-overlay-out_var(--motion-duration-quick)_var(--motion-ease-standard)] motion-reduce:animate-none";

export const dialogMotionClassName =
  "data-[state=open]:animate-[ui-dialog-in_var(--motion-duration-fast)_var(--motion-ease-standard)] data-[state=closed]:animate-[ui-dialog-out_var(--motion-duration-quick)_var(--motion-ease-standard)] motion-reduce:animate-none";

export const menuMotionClassName =
  "will-change-[transform,opacity,filter] data-[side=bottom]:[--motion-menu-x:0] data-[side=bottom]:[--motion-menu-y:calc(0rem-var(--motion-distance-micro))] data-[side=top]:[--motion-menu-x:0] data-[side=top]:[--motion-menu-y:var(--motion-distance-micro)] data-[side=left]:[--motion-menu-x:var(--motion-distance-micro)] data-[side=left]:[--motion-menu-y:0] data-[side=right]:[--motion-menu-x:calc(0rem-var(--motion-distance-micro))] data-[side=right]:[--motion-menu-y:0] data-[state=open]:animate-[ui-menu-in_var(--motion-duration-fast)_var(--motion-ease-standard)] data-[state=closed]:animate-[ui-menu-out_var(--motion-duration-quick)_var(--motion-ease-standard)] motion-reduce:animate-none";

export const fieldErrorMotionClassName =
  "aria-invalid:animate-[ui-field-error_var(--motion-duration-fast)_var(--motion-ease-standard)] motion-reduce:animate-none";
