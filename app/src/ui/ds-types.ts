/**
 * Types for the vendored design-system bundle.
 *
 * Transcribed from the skill's own per-component `.d.ts` declarations
 * (`~/.claude/skills/nihilium-design-system/references/components.md`), because the bundle ships no
 * types of its own and `@nihilium/ds` is not on npm. When the package publishes, delete this file
 * and import its types instead.
 *
 * Only the props are here. The components themselves arrive at runtime on `window.NihiliumDS`, so
 * the shape below is what `ds.ts` casts that global to.
 */
import type * as React from "react";

/**
 * Button — from @nihilium/ds@0.1.0.
 * @replaces button
 */
export interface ButtonProps {
  children: React.ReactNode;
  /** `solid` is the brand ink fill; `ghost` is an outlined secondary action. */
  variant?: "solid" | "ghost";
  /** Stretches to the container width — how the subscribe CTA is used. */
  fullWidth?: boolean;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  className?: string;
}


/**
 * Card — from @nihilium/ds@0.1.0.
 */
export interface CardProps {
  children: React.ReactNode;
  /** Padding: `sm` 1rem, `md` 1rem rising to 1.5rem on desktop, `lg` 1.5rem. */
  padding?: "sm" | "md" | "lg";
  /** Adds the hover scale used by the site's feature grids. Use it for cards that are clickable or that sit in a browsable gr */
  interactive?: boolean;
  className?: string;
}


/**
 * CardGrid — from @nihilium/ds@0.1.0.
 */
export interface CardGridProps {
  /** `Card` or `FeatureCard` children. */
  children: React.ReactNode;
  /** Columns at the widest breakpoint. `2` goes one-up then two-up at 768px. `3` goes one-up, two-up at 768px, three-up at 10 */
  columns?: 2 | 3;
  /** `lg` widens the desktop gutter from 1.5rem to 2rem. */
  gap?: "md" | "lg";
  className?: string;
}


/**
 * Checkbox — from @nihilium/ds@0.1.0.
 * @replaces input[type=checkbox]
 */
export interface CheckboxProps {
  /** Visible label, rendered small and muted beside the control. */
  label: React.ReactNode;
  id?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  disabled?: boolean;
  name?: string;
  className?: string;
}


/**
 * FeatureCard — from @nihilium/ds@0.1.0.
 */
export interface FeatureCardProps {
  /** Short noun phrase — "Context-Locked", "Observable". */
  title: React.ReactNode;
  /** One or two sentences of supporting copy. */
  children?: React.ReactNode;
  /** Outline icon, 2rem rising to 3rem on desktop. Pass a Heroicons outline element such as `<ShieldCheckIcon />`. */
  icon?: React.ReactNode;
  interactive?: boolean;
  className?: string;
}


/**
 * Heading — from @nihilium/ds@0.1.0.
 */
export interface HeadingProps {
  children: React.ReactNode;
  /** `1` is the brand wordmark treatment — uppercase, letter-spaced, extra bold, with a soft offset shadow. `2` titles a Sect */
  level?: 2 | 3 | 1 | 4;
  align?: "left" | "center";
  className?: string;
}


/**
 * Hero — from @nihilium/ds@0.1.0.
 */
export interface HeroProps {
  /** The wordmark line — rendered in the level-1 brand treatment. */
  title: React.ReactNode;
  /** One-line positioning statement, set large. */
  tagline?: React.ReactNode;
  /** Supporting paragraph, set smaller and muted. */
  description?: React.ReactNode;
  /** Mark above the title — an `<img>` or inline SVG. */
  logo?: React.ReactNode;
  id?: string;
  className?: string;
}


/**
 * Page — from @nihilium/ds@0.1.0.
 */
export interface PageProps {
  /** Sections of the page — normally `Hero` followed by `Section`s. */
  children: React.ReactNode;
  /** Full-viewport vertical scroll snapping, one section per screen. This is how nihilium.io reads; turn it off for long-form */
  snap?: boolean;
  className?: string;
}


/**
 * Section — from @nihilium/ds@0.1.0.
 */
export interface SectionProps {
  /** Section content — typically a `Heading` followed by a `CardGrid`. */
  children: React.ReactNode;
  /** Anchor id, e.g. `"section-2"`, so nav links can scroll to it. */
  id?: string;
  /** Content width cap: `sm` 48rem, `md` 56rem, `lg` 72rem, `xl` 80rem. Narrative sections use `md`; feature grids use `lg`. */
  width?: "sm" | "md" | "lg" | "xl";
  className?: string;
}


/**
 * StatusMessage — from @nihilium/ds@0.1.0.
 */
export interface StatusMessageProps {
  tone: "success" | "error";
  children: React.ReactNode;
  className?: string;
}


/**
 * SubscribeForm — from @nihilium/ds@0.1.0.
 */
export interface SubscribeFormProps {
  /** Card title. Defaults to `Stay Updated`. */
  title?: React.ReactNode;
  placeholder?: string;
  submitLabel?: string;
  submittingLabel?: string;
  consentLabel?: React.ReactNode;
  /** Feedback after a submit — render the result of your own API call. */
  status?: { tone: "success" | "error"; message: string; };
  /** Disables the control and swaps in `submittingLabel`. */
  submitting?: boolean;
  onSubmit?: (data: { email: string; consent: boolean; }) => void;
  className?: string;
}


/**
 * TextInput — from @nihilium/ds@0.1.0.
 * @replaces input
 */
export interface TextInputProps {
  type?: "text" | "email" | "password" | "url" | "search";
  value?: string;
  defaultValue?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  /** Always label the field — the site's inputs carry no visible label. */
  ariaLabel?: string;
  className?: string;
}


/**
 * TextLink — from @nihilium/ds@0.1.0.
 */
export interface TextLinkProps {
  href: string;
  children: React.ReactNode;
  /** Opens in a new tab with `rel="noopener noreferrer"`. */
  external?: boolean;
  /** Underlined by default — inline links in prose should stay underlined. */
  underline?: boolean;
  className?: string;
}


/**
 * TopBar — from @nihilium/ds@0.1.0.
 */
export interface TopBarProps {
  /** Wordmark text. Defaults to `NIHILIUM`. */
  brand?: React.ReactNode;
  /** Mark left of the wordmark, rendered at 2rem square. */
  logo?: React.ReactNode;
  links?: TopBarLink[];
  onBrandClick?: () => void;
  /** `fixed` pins it over the page; `static` keeps it in flow. */
  position?: "fixed" | "static";
  className?: string;
}

/** Not declared in the reference; read off the bundle's own `TopBar` implementation. */
export interface TopBarLink {
  label: string;
  href?: string;
  /** Adds `target="_blank"` and `rel="noopener noreferrer"`. */
  external?: boolean;
  onClick?: () => void;
  /** When set, replaces the label and moves it to `aria-label`. */
  icon?: React.ReactNode;
}

/** The six Heroicons outline marks the brand uses. Keep icon use consistent within one grid. */
export type IconProps = React.SVGProps<SVGSVGElement>;

/** What the vendored bundle assigns to `window.NihiliumDS`. */
export interface NihiliumDS {
  Button: React.ComponentType<ButtonProps>;
  Card: React.ComponentType<CardProps>;
  CardGrid: React.ComponentType<CardGridProps>;
  Checkbox: React.ComponentType<CheckboxProps>;
  FeatureCard: React.ComponentType<FeatureCardProps>;
  Heading: React.ComponentType<HeadingProps>;
  Hero: React.ComponentType<HeroProps>;
  Page: React.ComponentType<PageProps>;
  Section: React.ComponentType<SectionProps>;
  StatusMessage: React.ComponentType<StatusMessageProps>;
  SubscribeForm: React.ComponentType<SubscribeFormProps>;
  TextInput: React.ComponentType<TextInputProps>;
  TextLink: React.ComponentType<TextLinkProps>;
  TopBar: React.ComponentType<TopBarProps>;
  ShieldCheckIcon: React.ComponentType<IconProps>;
  KeyIcon: React.ComponentType<IconProps>;
  LockClosedIcon: React.ComponentType<IconProps>;
  ClockIcon: React.ComponentType<IconProps>;
  UserGroupIcon: React.ComponentType<IconProps>;
  DocumentCheckIcon: React.ComponentType<IconProps>;
}
