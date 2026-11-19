/** Mirror the mandatory public visual tokens for future feature utility classes. */
import type { Config } from 'tailwindcss';
const names = `surface surface-dim surface-bright surface-container-lowest surface-container-low surface-container surface-container-high
surface-container-highest surface-variant surface-tint inverse-surface background background-white on-surface on-surface-variant
inverse-on-surface on-background outline outline-variant primary on-primary primary-container on-primary-container inverse-primary
primary-fixed primary-fixed-dim on-primary-fixed on-primary-fixed-variant secondary on-secondary secondary-container on-secondary-container
secondary-fixed secondary-fixed-dim on-secondary-fixed on-secondary-fixed-variant tertiary on-tertiary tertiary-container on-tertiary-container
tertiary-fixed tertiary-fixed-dim on-tertiary-fixed on-tertiary-fixed-variant error on-error error-container on-error-container
status-info status-success status-warning living-green deep-forest-teal surface-tint-brand card-border primary-button-hover`.split(/\s+/);
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {
    colors: Object.fromEntries(names.map(name => [name, `var(--${name})`])),
    fontFamily: { sans: ['Public Sans', 'sans-serif'] },
    borderRadius: { sm: '.125rem', DEFAULT: '.25rem', md: '.375rem', lg: '.5rem', xl: '.75rem', full: '9999px' },
    spacing: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 6: '24px', 8: '32px', 12: '48px' },
    fontSize: {
      'headline-xl': ['48px', { lineHeight: '56px', fontWeight: '700', letterSpacing: '-.02em' }],
      'headline-lg': ['32px', { lineHeight: '40px', fontWeight: '700', letterSpacing: '-.01em' }],
      'headline-lg-mobile': ['28px', { lineHeight: '36px', fontWeight: '700' }],
      'headline-md': ['24px', { lineHeight: '32px', fontWeight: '600' }],
      'body-lg': ['18px', '28px'], 'body-md': ['16px', '24px'], 'body-sm': ['14px', '20px'],
      'label-md': ['14px', { lineHeight: '16px', fontWeight: '600', letterSpacing: '.05em' }],
      'label-sm': ['12px', { lineHeight: '16px', fontWeight: '600', letterSpacing: '.05em' }],
    },
  } }, plugins: [],
} satisfies Config;
