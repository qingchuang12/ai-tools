/**
 * 激活管理弹窗
 *
 * 状态分派：
 * - 未激活：选择「离线激活」/「在线激活」。离线激活展示机器码 + 激活码输入 + 激活按钮；
 *   在线激活为占位入口 + 输入框。
 * - 试用中 / 已激活：展示剩余时间 + 「去激活」按钮（去激活回到未激活流程）。
 */

import {useEffect, useState} from 'react';
import Modal from './Modal';
import {useActivationStore} from '../store/activationStore';
import {useElectronAPI} from '../lib/electron';

type Mode = 'choose' | 'offline' | 'online';

function formatRemaining(ms: number | null): string {
    if (ms === null) return '永久';
    const diff = ms - Date.now();
    if (diff <= 0) return '已过期';
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分`;
}

export default function ActivationModal() {
    const { state, modalOpen, closeModal, refresh } = useActivationStore();
    const api = useElectronAPI();
    const [mode, setMode] = useState<Mode>('choose');
    const [machineCode, setMachineCode] = useState('');
    const [code, setCode] = useState('');
    const [msg, setMsg] = useState<{ type: 'err' | 'ok'; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (modalOpen) {
            setMode('choose');
            setCode('');
            setMachineCode('');
            setMsg(null);
        }
    }, [modalOpen]);

    const openOffline = async () => {
        setMode('offline');
        setMsg(null);
        try {
            const mc = await api.activation.getMachineCode();
            setMachineCode(mc);
        } catch {
            setMsg({ type: 'err', text: '获取机器码失败' });
        }
    };

    const doOffline = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api.activation.offlineActivate(machineCode, code);
            if (r.success && r.state) {
                setMsg({ type: 'ok', text: '激活成功' });
                await refresh();
                setTimeout(() => closeModal(), 800);
            } else {
                setMsg({ type: 'err', text: r.error || '激活失败' });
            }
        } finally {
            setBusy(false);
        }
    };

    const doOnline = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api.activation.onlineActivate({ machineCode, code });
            setMsg({ type: r.success ? 'ok' : 'err', text: r.error || '在线激活尚未接入后端（占位）' });
        } finally {
            setBusy(false);
        }
    };

    const doDeactivate = async () => {
        setBusy(true);
        try {
            await api.activation.deactivate();
            await refresh();
            setMode('choose');
            setMsg(null);
        } finally {
            setBusy(false);
        }
    };

    const copyMachineCode = () => {
        navigator.clipboard?.writeText(machineCode);
        setMsg({ type: 'ok', text: '机器码已复制' });
    };

    if (!state) return null;

    const title =
        state.status === 'inactive' ? '激活' : state.status === 'trial' ? '试用中' : '已激活';

    return (
        <Modal isOpen={modalOpen} onClose={closeModal} title={title}>
            {state.status === 'inactive' && mode === 'choose' && (
                <div className="space-y-3">
                    <p className="text-[13px] text-[var(--color-muted)]">请选择激活方式：</p>
                    <button
                        onClick={openOffline}
                        className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-80 transition-opacity"
                    >
                        离线激活
                    </button>
                    <button
                        onClick={() => {
                            setMode('online');
                            setMsg(null);
                        }}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[13px] font-medium hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                    >
                        在线激活
                    </button>
                </div>
            )}

            {state.status === 'inactive' && mode === 'offline' && (
                <div className="space-y-3">
                    <div>
                        <label className="block text-[12px] text-[var(--color-muted)] mb-1">机器码</label>
                        <div className="flex gap-2">
                            <input
                                readOnly
                                value={machineCode}
                                placeholder="正在获取..."
                                className="flex-1 min-w-0 px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[12px] text-[var(--color-text)] font-mono"
                            />
                            <button
                                onClick={copyMachineCode}
                                className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                            >
                                复制
                            </button>
                        </div>
                    </div>
                    <div>
                        <label className="block text-[12px] text-[var(--color-muted)] mb-1">激活码</label>
                        <input
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            placeholder="请输入激活码"
                            className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[13px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
                        />
                    </div>
                    {msg && (
                        <p className={`text-[12px] ${msg.type === 'ok' ? 'text-[#34c759]' : 'text-[#ff3b30]'}`}>
                            {msg.text}
                        </p>
                    )}
                    <div className="flex gap-2">
                        <button
                            onClick={() => setMode('choose')}
                            className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-[13px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                        >
                            返回
                        </button>
                        <button
                            onClick={doOffline}
                            disabled={busy}
                            className="flex-1 px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
                        >
                            激活
                        </button>
                    </div>
                </div>
            )}

            {state.status === 'inactive' && mode === 'online' && (
                <div className="space-y-3">
                    <div>
                        <label className="block text-[12px] text-[var(--color-muted)] mb-1">在线激活码</label>
                        <input
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            placeholder="请输入在线激活码"
                            className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[13px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
                        />
                    </div>
                    <p className="text-[12px] text-[var(--color-muted)]">
                        在线激活尚未接入后端，当前为占位入口（后续对接 license 服务）。
                    </p>
                    <button
                        type="button"
                        onClick={() => api.system.openExternal('https://www.ywhome.top/getlicense')}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-accent)] text-[var(--color-accent)] text-[13px] font-medium hover:bg-[var(--color-accent)]/10 transition-colors"
                    >
                        获取激活码
                    </button>
                    {msg && (
                        <p className={`text-[12px] ${msg.type === 'ok' ? 'text-[#34c759]' : 'text-[#ff3b30]'}`}>
                            {msg.text}
                        </p>
                    )}
                    <div className="flex gap-2">
                        <button
                            onClick={() => setMode('choose')}
                            className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-[13px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                        >
                            返回
                        </button>
                        <button
                            onClick={doOnline}
                            disabled={busy}
                            className="flex-1 px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
                        >
                            激活
                        </button>
                    </div>
                </div>
            )}

            {state.status === 'trial' && (
                <div className="space-y-4">
                    <p className="text-[13px] text-[var(--color-text)]">
                        当前为试用版，剩余时间：
                        <span className="font-semibold text-[#ff9f0a] ml-1">
                            {formatRemaining(state.trialExpiresAt)}
                        </span>
                    </p>
                    <button
                        onClick={doDeactivate}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[#ff3b30] text-[13px] font-medium hover:bg-[#ff3b30]/10 transition-colors disabled:opacity-50"
                    >
                        去激活
                    </button>
                </div>
            )}

            {state.status === 'activated' && (
                <div className="space-y-4">
                    <p className="text-[13px] text-[var(--color-text)]">
                        已激活，剩余时间：
                        <span className="font-semibold text-[#34c759] ml-1">
                            {formatRemaining(state.activatedExpiresAt)}
                        </span>
                    </p>
                    <button
                        onClick={doDeactivate}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[#ff3b30] text-[13px] font-medium hover:bg-[#ff3b30]/10 transition-colors disabled:opacity-50"
                    >
                        去激活
                    </button>
                </div>
            )}
        </Modal>
    );
}
