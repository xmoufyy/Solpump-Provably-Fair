/* shadcn/ui-style primitives (copied pattern: cva variants + cn), themed for the lab. */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-40 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-accent text-white hover:bg-accent/85 shadow-[0_2px_0_#5b3aa8]",
        secondary: "bg-panel-2 text-fg border border-line hover:bg-tile",
        ghost: "text-muted hover:bg-panel-2 hover:text-fg",
        danger: "bg-bad/15 text-bad border border-bad/30 hover:bg-bad/25",
        outline: "border border-line text-fg hover:border-accent/60",
      },
      size: { default: "h-9 px-4", sm: "h-8 px-3 text-xs", lg: "h-11 px-6 text-base", icon: "h-9 w-9" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-2xl border border-line bg-panel shadow-[0_8px_30px_rgb(0_0_0/0.25)]", className)} {...props} />;
}
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-between gap-2 border-b border-line px-5 py-3.5", className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-sm font-semibold tracking-wide text-fg", className)} {...props} />;
}
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      spellCheck={false}
      autoComplete="off"
      className={cn(
        "h-9 w-full rounded-lg border bg-bg px-3 font-mono text-sm text-fg placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/50",
        invalid ? "border-bad/70" : "border-line",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  ({ className, invalid, ...props }, ref) => (
    <textarea
      ref={ref}
      spellCheck={false}
      className={cn(
        "w-full rounded-lg border bg-bg px-3 py-2 font-mono text-sm text-fg placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/50 scrollbar-thin",
        invalid ? "border-bad/70" : "border-line",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted", className)} {...props} />;
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn("h-9 w-full rounded-lg border border-line bg-bg px-3 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/50", className)}
      {...props}
    />
  );
}

const badgeVariants = cva("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium", {
  variants: {
    tone: {
      ok: "border-ok/30 bg-ok/10 text-ok",
      bad: "border-bad/30 bg-bad/10 text-bad",
      warn: "border-warn/30 bg-warn/10 text-warn",
      info: "border-info/30 bg-info/10 text-info",
      neutral: "border-line bg-panel-2 text-muted",
      accent: "border-accent/40 bg-accent/15 text-accent-2",
    },
  },
  defaultVariants: { tone: "neutral" },
});
export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/** Segmented control (shadcn ToggleGroup look). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className,
  testId,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; disabled?: boolean }[];
  onChange: (v: T) => void;
  className?: string;
  testId?: string;
}) {
  return (
    <div role="radiogroup" data-testid={testId} className={cn("flex flex-wrap gap-1 rounded-xl border border-line bg-bg p-1", className)}>
      {options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === value}
          key={String(o.value)}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-30",
            o.value === value ? "bg-accent text-white shadow-[0_2px_0_#5b3aa8]" : "text-muted hover:bg-panel-2 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-1 text-xs text-bad">{children}</p>;
}
