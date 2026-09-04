export type MusicChatSharePayload = {
    type: "music";
    title: string;
    artist: string;
};

export type XiaohongshuNoteChatSharePayload = {
    type: "xiaohongshu_note";
    authorName: string;
    title: string;
    body: string;
    description?: string;
    noteType: "post" | "video";
    tags?: string[];
    imageAssetId?: string;
    coverIcon?: string;
    tone?: string;
};

export type XiaohongshuReaderComment = {
    user?: string;
    content?: string;
    ipLocation?: string;
    likeCount?: number;
};

export type ChatSharePayload = MusicChatSharePayload | XiaohongshuNoteChatSharePayload;

function compactShareText(value: string | undefined, fallback: string): string {
    const text = (value || "").replace(/\s+/g, " ").trim();
    return text || fallback;
}

export function formatXiaohongshuShareForPrompt(input: {
    author?: string;
    title?: string;
    body?: string;
    description?: string;
}): string {
    const author = compactShareText(input.author, "未知作者");
    const title = compactShareText(input.title, "无标题");
    const body = compactShareText(input.body, "无正文内容");
    const description = compactShareText(input.description, "");
    return `分享了一条小红书帖子，作者：${author}, 标题：${title}, 正文内容：${body}，图片/视频描述：${description || "无"}`;
}

export function formatXiaohongshuReaderCardForPrompt(input: {
    author?: string;
    title?: string;
    body?: string;
    description?: string;
    tags?: string[];
    comments?: XiaohongshuReaderComment[];
}): string {
    const base = formatXiaohongshuShareForPrompt(input);
    const tags = (input.tags || [])
        .map(tag => compactShareText(tag, ""))
        .filter(Boolean)
        .join("、");
    const comments = (input.comments || [])
        .map((comment, index) => {
            const user = compactShareText(comment.user, "匿名用户");
            const content = compactShareText(comment.content, "");
            if (!content) return "";
            const location = compactShareText(comment.ipLocation, "");
            const likes = comment.likeCount && comment.likeCount > 0 ? " [" + comment.likeCount + "赞]" : "";
            return (index + 1) + "." + user + (location ? "（" + location + "）" : "") + "：" + content + likes;
        })
        .filter(Boolean)
        .join("；");
    return base + (tags ? "，标签：" + tags : "") + (comments ? "，评论区：" + comments : "");
}
