export function Brand() {
  return <span className="topbar-brand">
    <img className="brand-mark" src={`${import.meta.env.BASE_URL}brand/mollytime-icon.svg`} alt="" aria-hidden="true" width="32" height="32" />
    <span>MollyTime</span>
  </span>;
}
