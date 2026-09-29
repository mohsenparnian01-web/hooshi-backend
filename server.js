const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.get('/', (req, res) => {
    res.send('Hooshi AI Backend Server is Running!');
});

wss.on('connection', (ws) => {
    console.log('گوشی با موفقیت متصل شد.');

    ws.on('message', (message) => {
        try {
            // اگر داده متنی (JSON) باشد
            if (typeof message === 'string' || message instanceof String) {
                const parsed = JSON.parse(message);
                if (parsed.event === 'wake_word_detected') {
                    console.log('کلمه "هوشی" شنیده شد!');
                    ws.send(JSON.stringify({
                        event: 'assistant_response',
                        text: 'جانم؟ در خدمت شما هستم.',
                        should_speak: true
                    }));
                }
            } else {
                // داده صوتی جلسه (Binary Audio Buffer)
                console.log('بافر صوتی جلسه دریافت شد.');
            }
        } catch (e) {
            console.error('خطا در دریافت پیام:', e);
        }
    });

    ws.on('close', () => console.log('ارتباط گوشی قطع شد.'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});

