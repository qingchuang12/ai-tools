/**
 * 可折叠 JSON 树视图
 *
 * 替换原 react-syntax-highlighter 的纯高亮结果区：支持对象/数组节点展开与折叠，
 * 折叠时显示条目数摘要，便于在大数据量下查看。配色随主题自适应（dark / light）。
 */

import {useState} from 'react';

interface JsonTreeProps {
    data: unknown;
    isDark: boolean;
}

const PALETTE = {
    dark: { key: '#79b8ff', string: '#98c379', number: '#d19a66', boolean: '#c678dd', nil: '#7f848e', punct: '#abb2bf', toggle: '#61afef', summary: '#7f848e' },
    light: { key: '#1f6feb', string: '#2e7d32', number: '#b25000', boolean: '#8e24aa', nil: '#9e9e9e', punct: '#37474f', toggle: '#0366d6', summary: '#6b7280' },
};

function isExpandable(v: unknown): v is Record<string, unknown> | unknown[] {
    return v !== null && typeof v === 'object';
}

function ValueSpan({ value, c }: { value: unknown; c: (typeof PALETTE)['dark'] }) {
    if (typeof value === 'string') return <span style={{ color: c.string }}>"{value}"</span>;
    if (typeof value === 'number') return <span style={{ color: c.number }}>{value}</span>;
    if (typeof value === 'boolean') return <span style={{ color: c.boolean }}>{String(value)}</span>;
    if (value === null) return <span style={{ color: c.nil }}>null</span>;
    return <span>{String(value)}</span>;
}

interface NodeProps {
    keyName?: string;
    value: unknown;
    isDark: boolean;
    depth: number;
}

function JsonNode({ keyName, value, isDark, depth }: NodeProps) {
    const c = isDark ? PALETTE.dark : PALETTE.light;
    const [open, setOpen] = useState(depth < 2);

    if (!isExpandable(value)) {
        return (
            <div style={{ paddingLeft: depth * 16 }} className="leading-relaxed">
                {keyName !== undefined && <span style={{ color: c.key }}>{keyName}: </span>}
                <ValueSpan value={value} c={c} />
            </div>
        );
    }

    const arr = Array.isArray(value);
    const entries: [string, unknown][] = arr
        ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
        : Object.entries(value as Record<string, unknown>);
    const summary = arr ? `Array(${entries.length})` : `{${entries.length}}`;

    return (
        <div>
            <div
                style={{ paddingLeft: depth * 16 }}
                className="leading-relaxed cursor-pointer select-none hover:bg-[var(--color-surface-hover)]/40"
                onClick={() => setOpen((o) => !o)}
            >
                <span style={{ color: c.toggle }} className="mr-1 inline-block w-3 text-[10px]">
                    {open ? '▼' : '▶'}
                </span>
                {keyName !== undefined && <span style={{ color: c.key }}>{keyName}: </span>}
                {!open && (
                    <span style={{ color: c.summary }}>
                        {arr ? '[ ' : '{ '}
                        {summary}
                        {arr ? ' ]' : ' }'}
                    </span>
                )}
            </div>
            {open && (
                <div>
                    {entries.map(([k, v]) => (
                        <JsonNode key={k} keyName={k} value={v} isDark={isDark} depth={depth + 1} />
                    ))}
                    <div style={{ paddingLeft: depth * 16 + 16 }} className="leading-relaxed">
                        <span style={{ color: c.punct }}>{arr ? ']' : '}'}</span>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function JsonTree({ data, isDark }: JsonTreeProps) {
    const c = isDark ? PALETTE.dark : PALETTE.light;
    return (
        <div className="text-[12px] font-mono">
            {isExpandable(data) ? (
                <JsonNode value={data} isDark={isDark} depth={0} />
            ) : (
                <ValueSpan value={data} c={c} />
            )}
        </div>
    );
}
