/**
 * 通用加载骨架屏（避免「暂无数据」空状态在数据返回前闪现）
 */
export default function LoadingSkeleton() {
    return (
        <div className="p-4">
            <div className="card overflow-hidden divide-y divide-[var(--color-border)]">
                {[0, 1, 2].map(i => (
                    <div key={i} className="flex items-center gap-3 px-4 py-3">
                        <div className="w-8 h-8 rounded bg-[var(--color-surface-hover)] animate-pulse"/>
                        <div className="flex-1 space-y-2">
                            <div className="h-3 w-32 bg-[var(--color-surface-hover)] rounded animate-pulse"/>
                            <div className="h-2.5 w-20 bg-[var(--color-surface-hover)] rounded animate-pulse"/>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
