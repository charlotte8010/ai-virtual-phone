"use client";

import type { ComponentProps } from "react";
import { MessageBubble as BaseMessageBubble } from "./message-bubble-base";

export * from "./message-bubble-base";

type MessageBubbleProps = ComponentProps<typeof BaseMessageBubble>;

// 插件消息的 mediaData 会在落库后异步补全。宿主收到 storage reload 后，
// 用消息对象身份给插件气泡一个稳定的 render revision：普通消息继续交给
// BaseMessageBubble 自己的 memo；plugin:* 只有对象真的换新时才 remount，
// 从而让自定义 renderer 拿到最新 mediaData，而不是卡在初始 loading payload。
const pluginMessageRenderRevisions = new WeakMap<object, number>();
let pluginMessageRenderRevisionSeq = 0;

function getPluginMessageRenderKey(msg: MessageBubbleProps["msg"]): string | undefined {
    if (!msg.mediaType?.startsWith("plugin:")) return undefined;
    let revision = pluginMessageRenderRevisions.get(msg);
    if (revision === undefined) {
        revision = ++pluginMessageRenderRevisionSeq;
        pluginMessageRenderRevisions.set(msg, revision);
    }
    return `${msg.id}:${revision}`;
}

export function MessageBubble(props: MessageBubbleProps) {
    return <BaseMessageBubble key={getPluginMessageRenderKey(props.msg)} {...props} />;
}
