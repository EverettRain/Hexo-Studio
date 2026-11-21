/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  content: ["./src/index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", ".dark"],
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        card: { DEFAULT: token("card"), 2: token("card-2") },
        pill: { DEFAULT: token("pill"), hover: token("pill-hover") },
        line: { DEFAULT: token("line"), 2: token("line-2") },
        fg: { DEFAULT: token("fg"), 2: token("fg-2") },
        muted: token("muted"),
        faint: token("faint"),
        brand: { DEFAULT: token("brand"), soft: token("brand-soft"), fg: token("brand-fg") },
        accent: token("accent"),
        ok: { DEFAULT: token("ok"), soft: token("ok-soft") },
        danger: { DEFAULT: token("danger"), soft: token("danger-soft") },
        warn: { DEFAULT: token("warn"), soft: token("warn-soft") },
        primary: { DEFAULT: token("primary"), fg: token("primary-fg") },
        raised: { DEFAULT: "var(--raised)", strong: "var(--raised-strong)" },
        scrim: "var(--scrim)",
      },
      boxShadow: {
        edge: "var(--edge)",
        card: "var(--card-edge)",
        pop: "var(--shadow)",
      },
      // Every size is the theme's (index.css); `full` stays round.
      borderRadius: {
        DEFAULT: "var(--radius)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        control: "var(--radius-control)",
        lg: "var(--radius-lg)",
        item: "var(--radius-item)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
      },
      fontFamily: {
        sans: [
          "-apple-system", "BlinkMacSystemFont", '"SF Pro Text"', '"Segoe UI Variable Text"', '"Segoe UI"',
          '"PingFang SC"', '"Microsoft YaHei UI"', "system-ui", "sans-serif",
        ],
        mono: ["ui-monospace", '"SF Mono"', "Menlo", "Consolas", "monospace"],
      },
      transitionTimingFunction: { soft: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        popIn: { "0%": { opacity: "0", transform: "translateY(4px) scale(0.985)" }, "100%": { opacity: "1", transform: "none" } },
        slideIn: { "0%": { opacity: "0", transform: "translateX(16px)" }, "100%": { opacity: "1", transform: "none" } },
      },
      animation: {
        "fade-in": "fadeIn 0.16s ease-out",
        "pop-in": "popIn 0.18s cubic-bezier(0.2, 0.8, 0.2, 1)",
        "slide-in": "slideIn 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
    },
  },
  plugins: [],
};
