interface Props {
  name: string;
  color: string;
  size?: 'sm' | 'md';
  ring?: boolean;
}

export function Avatar({ name, color, size = 'md', ring = false }: Props) {
  const box = size === 'sm' ? 'h-6 w-6 text-[11px]' : 'h-8 w-8 text-sm';
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-black/80 ${box} ${ring ? 'ring-canvas ring-2' : ''}`}
      style={{ backgroundColor: color }}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
