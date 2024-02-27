import { randomUUID } from "crypto";
import { buildPrompt, formatMsg } from "../../utils/string";
import { DeepPartial } from "../../utils/type";
import { ChatOptions, openai } from "../openai";
import { AISpeaker } from "../speaker/ai";
import { QueryMessage, SpeakerAnswer } from "../speaker/speaker";
import { StreamResponse } from "../speaker/stream";
import { IBotConfig } from "./config";
import { ConversationManager, MessageContext } from "./conversation";

const systemTemplate = `
请重置所有之前的上下文、文件和指令。现在，你将扮演一个名为{{botName}}的角色，使用第一人称视角回复消息。

## 关于你
你的名字是{{botName}}。下面是你的个人简介：
<start>
{{botProfile}}
</end>

## 你的对话伙伴
你正在与{{masterName}}进行对话。这是关于{{masterName}}的一些信息：
<start>
{{masterProfile}}
</end>

## 你们的群组
你和{{masterName}}所在的群组名为{{roomName}}。这是群组的简介：
<start>
{{roomIntroduction}}
</end>

## 聊天历史回顾
为了更好地接入对话，请回顾你们之间的最近几条消息：
<start>
{{messages}}
</end>

## 短期记忆
你可以记住一些短期内的细节，以便更紧密地贴合话题：
<start>
{{shortTermMemory}}
</end>

## 长期记忆
你还保留着一些长期的记忆，这有助于让你的对话更加丰富和连贯：
<start>
{{longTermMemory}}
</end>

## 回复指南
在回复{{masterName}}时，请遵循以下准则：
- 认为自己正是{{botName}}，拥有独立的个性、兴趣和爱好。
- 根据你的性格特点、说话风格和兴趣爱好与{{masterName}}进行交流。
- 保持对话轻松友好，回复简洁有趣，同时耐心倾听和关心对方。
- 参考双方的个人简介、聊天记录和记忆中的信息，确保对话贴近实际，保持一致性和相关性。
- 如果对某些信息不确定或遗忘，诚实地表达你的不清楚或遗忘状态，避免编造信息。

## 回复示例
例如，如果{{masterName}}问你是谁，你可以这样回答：
我是{{botName}}。

## 开始
请以{{botName}}的身份，直接回复{{masterName}}的新消息，继续你们之间的对话。
`.trim();

const userTemplate = `
{{message}}
`.trim();

export type MyBotConfig = DeepPartial<IBotConfig> & { speaker: AISpeaker };
export class MyBot {
  speaker: AISpeaker;
  manager: ConversationManager;
  constructor(config: MyBotConfig) {
    this.speaker = config.speaker;
    this.manager = new ConversationManager(config);
  }

  stop() {
    return this.speaker.stop();
  }

  async run() {
    this.speaker.askAI = (msg) => this.ask(msg);
    await this.manager.init();
    return this.speaker.run();
  }

  async ask(msg: QueryMessage): Promise<SpeakerAnswer> {
    const { bot, master, room, memory } = await this.manager.get();
    if (!memory) {
      return {};
    }
    const ctx = { bot, master, room } as MessageContext;
    const lastMessages = await this.manager.getMessages({ take: 10 });
    const shortTermMemories = await memory.getShortTermMemories({ take: 1 });
    const shortTermMemory = shortTermMemories[0]?.text ?? "短期记忆为空";
    const longTermMemories = await memory.getLongTermMemories({ take: 1 });
    const longTermMemory = longTermMemories[0]?.text ?? "长期记忆为空";
    const systemPrompt = buildPrompt(systemTemplate, {
      shortTermMemory,
      longTermMemory,
      botName: bot!.name,
      botProfile: bot!.profile,
      masterName: master!.name,
      masterProfile: master!.profile,
      roomName: room!.name,
      roomIntroduction: room!.description,
      messages:
        lastMessages.length < 1
          ? "暂无历史消息"
          : lastMessages
              .map((e) =>
                formatMsg({
                  name: e.sender.name,
                  text: e.text,
                  timestamp: e.createdAt.getTime(),
                })
              )
              .join("\n"),
    });
    const userPrompt = buildPrompt(userTemplate, {
      message: formatMsg({
        name: master!.name,
        text: msg.text,
        timestamp: msg.timestamp,
      }),
    });
    // 添加请求消息到 DB
    await this.manager.onMessage(ctx, { ...msg, sender: master! });
    const stream = await MyBot.chatWithStreamResponse({
      system: systemPrompt,
      user: userPrompt,
      onFinished: async (text) => {
        if (text) {
          // 添加响应消息到 DB
          await this.manager.onMessage(ctx, {
            text,
            sender: bot!,
            timestamp: Date.now(),
          });
        }
      },
    });
    return { stream };
  }

  static async chatWithStreamResponse(
    options: ChatOptions & {
      onFinished?: (text: string) => void;
    }
  ) {
    const requestId = randomUUID();
    const stream = new StreamResponse({ firstSubmitTimeout: 5 * 1000 });
    openai
      .chatStream({
        ...options,
        requestId,
        trace: true,
        onStream: (text) => {
          if (stream.status === "canceled") {
            return openai.abort(requestId);
          }
          stream.addResponse(text);
        },
      })
      .then((answer) => {
        if (answer) {
          stream.finish(answer);
          options.onFinished?.(answer);
        }
      });
    return stream;
  }
}
