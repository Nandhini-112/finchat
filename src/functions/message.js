
const {
    ActivityHandler,
    CloudAdapter,
    ConfigurationBotFrameworkAuthentication,
    TurnContext
} = require('botbuilder');

const { app } = require('@azure/functions');

// ============================================================
// FINCHAT-TEAMS BOT AUTHENTICATION
// ============================================================

const botAuthentication =
    new ConfigurationBotFrameworkAuthentication(process.env);

const adapter = new CloudAdapter(botAuthentication);

// ============================================================
// ERROR HANDLING
// ============================================================

adapter.onTurnError = async (context, error) => {
    console.error('[finchat-teams] Bot error:', error);

    await context.sendActivity(
        'Sorry, finchat-teams encountered an error. Please try again.'
    );
};

// ============================================================
// FINCHAT-TEAMS BOT
// ============================================================

class FinchatTeamsBot extends ActivityHandler {
    constructor() {
        super();

        this.onMessage(async (context, next) => {
            try {
                let question = context.activity.text || '';

                // Remove bot mention in Teams conversations.
                question =
                    TurnContext.removeRecipientMention(
                        context.activity
                    ) || question;

                question = question.trim();

                if (!question) {
                    await context.sendActivity(
                        'Hello! I am finchat-teams. Please enter your finance or HR question.'
                    );

                    await next();
                    return;
                }

                console.log(
                    `[finchat-teams] Question received: ${question}`
                );

                const chatUrl = process.env.FINORA_CHAT_URL;

                if (!chatUrl) {
                    throw new Error(
                        'FINORA_CHAT_URL is missing from application settings.'
                    );
                }

                // Call the existing Finora AI backend.
                const response = await fetch(chatUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        question
                    })
                });

                const responseText = await response.text();

                let result;

                try {
                    result = JSON.parse(responseText);
                } catch {
                    throw new Error(
                        `Invalid backend JSON response. HTTP ${response.status}`
                    );
                }

                if (!response.ok) {
                    throw new Error(
                        `Finora API failed with HTTP ${response.status}`
                    );
                }

                if (!result.answer) {
                    throw new Error(
                        'No answer returned from Finora backend.'
                    );
                }

                // Return the original backend answer.
                await context.sendActivity({
                    type: 'message',
                    text: result.answer
                });

                console.log(
                    '[finchat-teams] Answer delivered successfully.'
                );

            } catch (error) {
                console.error(
                    '[finchat-teams] Processing error:',
                    error
                );

                await context.sendActivity(
                    'Unable to process your question right now. Please try again later.'
                );
            }

            await next();
        });
    }
}

const finchatBot = new FinchatTeamsBot();

// ============================================================
// AZURE FUNCTIONS V4 HTTP ENDPOINT
// ============================================================

class BotHttpResponse {
    constructor() {
        this.statusCode = 200;
        this.headers = {};
        this.body = undefined;
    }

    status(code) {
        this.statusCode = code;
        return this;
    }

    header(name, value) {
        this.headers[name.toLowerCase()] = String(value);
        return this;
    }

    send(body) {
        this.body = body;
        return this;
    }

    end(body) {
        if (body !== undefined) {
            this.body = body;
        }

        return this;
    }
}

// ============================================================
// POST /api/messages
// ============================================================

app.http('messages', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'messages',

    handler: async (request, context) => {
        context.log(
            '[finchat-teams] Incoming Bot Framework request.'
        );

        try {
            const activity = await request.json();

            const botRequest = {
                method: request.method,
                headers: Object.fromEntries(
                    request.headers.entries()
                ),
                body: activity
            };

            const botResponse = new BotHttpResponse();

            await adapter.process(
                botRequest,
                botResponse,
                async (turnContext) => {
                    await finchatBot.run(turnContext);
                }
            );

            return {
                status: botResponse.statusCode,
                headers: botResponse.headers,
                body: botResponse.body === undefined
                    ? undefined
                    : typeof botResponse.body === 'string'
                        ? botResponse.body
                        : JSON.stringify(botResponse.body)
            };

        } catch (error) {
            context.error(
                '[finchat-teams] Messaging endpoint failed:',
                error
            );

            return {
                status: 500,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    status: 'ERROR',
                    bot: 'finchat-teams',
                    message: 'Bot message processing failed.'
                })
            };
        }
    }
});
