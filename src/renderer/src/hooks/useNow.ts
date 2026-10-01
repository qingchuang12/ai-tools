import {useEffect, useState} from 'react';

/**
 * 组件本地秒级时钟：仅在 `active` 为真时按 `intervalMs` 推进并触发本组件重渲染。
 *
 * 用于把「剩余时间倒计时」的重渲染**下沉到真正显示倒计时的组件**：全局激活 store 不再每秒
 * `set({state:{...s}})`（那会让所有订阅者每秒重渲染，plan-1.0 / F12）。组件在倒计时可见时
 * 才开启本 hook，弹窗关闭 / 无到期时间时自动停表，零空转。
 *
 * 返回值即「当前时间戳」，调用方可直接用它做差值计算；也可只调用不取值，借其 state 更新驱动重渲染，
 * 让组件里读取 `Date.now()` 的格式化函数在每秒重渲染时取到新值。
 */
export function useNow(intervalMs = 1000, active = true): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs, active]);
    return now;
}
