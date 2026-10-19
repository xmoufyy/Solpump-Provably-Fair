import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const axis = { stroke: "#7d7590", fontSize: 12 };
const tooltipStyle = { background: "#19171f", border: "1px solid #322d3e", borderRadius: 10, color: "#ece8f4", fontSize: 12 };

export const STATUS_COLORS: Record<string, string> = {
  match: "#34d399",
  mismatch: "#f87171",
  reconstructed: "#8b5cf6",
  missing_comparison: "#a78bfa",
  invalid_input: "#fbbf24",
  unsupported_version: "#f59e0b",
  other: "#8b5cf6",
};
const LABELS: Record<string, string> = {
  match: "Match",
  mismatch: "Mismatch",
  reconstructed: "Reconstructed",
  missing_comparison: "Missing comparison",
  invalid_input: "Invalid",
  unsupported_version: "Unsupported",
  other: "Other",
};

export function StatusByGameChart({ data }: { data: Record<string, number | string>[] }) {
  const keys = ["match", "mismatch", "reconstructed", "missing_comparison", "invalid_input", "unsupported_version"];
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke="#2a2533" vertical={false} />
        <XAxis dataKey="game" tick={axis} axisLine={false} tickLine={false} tickFormatter={(g) => g[0].toUpperCase() + g.slice(1)} />
        <YAxis allowDecimals={false} tick={axis} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgb(139 92 246 / 0.08)" }} />
        <Legend formatter={(v) => <span style={{ color: "#9c94ad", fontSize: 12 }}>{LABELS[v] ?? v}</span>} />
        {keys.map((k, i) => (
          <Bar key={k} dataKey={k} stackId="s" fill={STATUS_COLORS[k]} radius={i === keys.length - 1 ? [6, 6, 0, 0] : 0} maxBarSize={56} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function OverTimeChart({ data }: { data: { date: string; match: number; mismatch: number; other: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
        <CartesianGrid stroke="#2a2533" vertical={false} />
        <XAxis dataKey="date" tick={axis} axisLine={false} tickLine={false} />
        <YAxis allowDecimals={false} tick={axis} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend formatter={(v) => <span style={{ color: "#9c94ad", fontSize: 12 }}>{LABELS[v] ?? v}</span>} />
        {(["match", "mismatch", "other"] as const).map((k) => (
          <Line key={k} type="monotone" dataKey={k} stroke={STATUS_COLORS[k]} strokeWidth={2} dot={{ r: 3 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
