import { expect, type Locator } from "@playwright/test";

export async function chooseSelect(control: Locator, option: string | { label: string }) {
  await control.click();
  const page = control.page();
  if (typeof option === "string") {
    await page.locator(`[role="option"][data-value=${JSON.stringify(option)}]`).click();
  } else {
    await page.getByRole("option", { name: option.label, exact: true }).click();
  }
  await expect(page.getByRole("listbox")).toHaveCount(0);
}
