// The Cadabra mark: a four-point spark with a small companion twinkle.
export const SPARK_PATH = 'M12 1.5c.9 6.1 4.4 9.6 10.5 10.5-6.1.9-9.6 4.4-10.5 10.5-.9-6.1-4.4-9.6-10.5-10.5C7.6 11.1 11.1 7.6 12 1.5Z';

export function sparkSvg(size = 18, id = 'sg'): string {
  return `<svg class="spark" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF1C4"/><stop offset=".45" stop-color="#FFD27A"/><stop offset="1" stop-color="#E9A23B"/></linearGradient></defs>
  <path d="${SPARK_PATH}" fill="url(#${id})"/>
  <path d="M20 2.2c.2 1.3.9 2 2.2 2.2-1.3.2-2 .9-2.2 2.2-.2-1.3-.9-2-2.2-2.2 1.3-.2 2-.9 2.2-2.2Z" fill="#FFE7A8" opacity=".85"/>
</svg>`;
}
