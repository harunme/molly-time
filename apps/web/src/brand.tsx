export function BrandMark({ transparent = false }: { transparent?: boolean }) {
  return <img className="brand-mark" src={`${import.meta.env.BASE_URL}brand/mollytime-icon${transparent ? '-transparent' : ''}.svg`} alt="" aria-hidden="true" width="32" height="32" />;
}

export function BrandWordmark({ onDark = false }: { onDark?: boolean }) {
  return <img className="brand-wordmark" src={`${import.meta.env.BASE_URL}brand/mollytime-wordmark${onDark ? '-on-dark' : ''}.svg`} alt="MollyTime" width="144" height="32" />;
}
