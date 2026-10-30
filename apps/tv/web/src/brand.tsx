export function Brand() {
  return <span className="topbar-brand">
    <img className="brand-mark" src={`${import.meta.env.BASE_URL}brand/mollytime-mark.svg`} alt="" aria-hidden="true" width="32" height="32" />
    <img className="brand-wordmark" src={`${import.meta.env.BASE_URL}brand/mollytime-wordmark-on-dark.svg`} alt="MollyTime" width="120" height="28" />
  </span>;
}
