// GeminiLiveClient — thin browser WebSocket client for the Gemini Live API.
// Authenticates with a single-use ephemeral token minted by our backend
// (/token), then streams audio in both directions and surfaces transcripts
// and tool calls via callbacks.

(function (global) {
  'use strict';

  const WS_BASE =
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

  class GeminiLiveClient {
    constructor({
      model = 'models/gemini-3.1-flash-live-preview',
      systemInstruction = '',
      tools = [],
      voiceName = 'Aoede',
      onAudioReceived = () => {},
      onTranscriptUser = () => {},
      onTranscriptModel = () => {},
      onToolCall = () => {},
      onTurnComplete = () => {},
      onInterrupted = () => {},
      onOpen = () => {},
      onClose = () => {},
      onError = () => {},
    } = {}) {
      this.model = model;
      this.systemInstruction = systemInstruction;
      this.tools = tools;
      this.voiceName = voiceName;
      this.callbacks = {
        onAudioReceived,
        onTranscriptUser,
        onTranscriptModel,
        onToolCall,
        onTurnComplete,
        onInterrupted,
        onOpen,
        onClose,
        onError,
      };
      this.ws = null;
      this.connected = false;
    }

    connect(ephemeralToken) {
      return new Promise((resolve, reject) => {
        const url = `${WS_BASE}?key=${encodeURIComponent(ephemeralToken)}`;
        let settled = false;
        let ws;
        try {
          ws = new WebSocket(url);
        } catch (err) {
          reject(err);
          return;
        }
        this.ws = ws;

        ws.onopen = () => {
          const setup = {
            setup: {
              model: this.model,
              generation_config: {
                response_modalities: ['AUDIO'],
                speech_config: {
                  voice_config: {
                    prebuilt_voice_config: { voice_name: this.voiceName },
                  },
                },
              },
              system_instruction: {
                parts: [{ text: this.systemInstruction }],
              },
              tools: this.tools && this.tools.length
                ? [{ function_declarations: this.tools }]
                : undefined,
              input_audio_transcription: {},
              output_audio_transcription: {},
            },
          };
          ws.send(JSON.stringify(setup));
        };

        ws.onmessage = async (event) => {
          let raw = event.data;
          // The Live API sends Blob frames in some browsers — normalize to text.
          if (raw instanceof Blob) {
            raw = await raw.text();
          } else if (raw instanceof ArrayBuffer) {
            raw = new TextDecoder().decode(raw);
          }
          let msg;
          try {
            msg = JSON.parse(raw);
          } catch (err) {
            console.warn('[gemini-live] non-JSON message', raw);
            return;
          }
          this._handleMessage(msg, () => {
            if (!settled) {
              settled = true;
              this.connected = true;
              this.callbacks.onOpen();
              resolve();
            }
          });
        };

        ws.onerror = (event) => {
          this.callbacks.onError(event);
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket error before setup completed'));
          }
        };

        ws.onclose = (event) => {
          this.connected = false;
          this.callbacks.onClose(event);
          if (!settled) {
            settled = true;
            reject(
              new Error(
                `WebSocket closed before setup (code ${event.code}: ${event.reason || 'no reason'})`
              )
            );
          }
        };
      });
    }

    _handleMessage(msg, onSetupComplete) {
      if (msg.setupComplete) {
        onSetupComplete && onSetupComplete();
        return;
      }

      const sc = msg.serverContent;
      if (sc) {
        if (sc.interrupted) this.callbacks.onInterrupted();

        if (sc.inputTranscription && sc.inputTranscription.text) {
          this.callbacks.onTranscriptUser(sc.inputTranscription.text, !!sc.inputTranscription.finished);
        }
        if (sc.outputTranscription && sc.outputTranscription.text) {
          this.callbacks.onTranscriptModel(sc.outputTranscription.text, !!sc.outputTranscription.finished);
        }
        if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData && typeof part.inlineData.data === 'string') {
              // Audio chunk (PCM16 @ 24kHz).
              this.callbacks.onAudioReceived(part.inlineData.data);
            } else if (part.text) {
              this.callbacks.onTranscriptModel(part.text, false);
            }
          }
        }
        if (sc.turnComplete || sc.generationComplete) {
          this.callbacks.onTurnComplete();
        }
      }

      if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
        for (const call of msg.toolCall.functionCalls) {
          this.callbacks.onToolCall(call);
        }
      }

      if (msg.goAway) {
        // Server signaled imminent disconnect. Surface as a soft error.
        this.callbacks.onError(new Error('Server sent goAway: ' + (msg.goAway.timeLeft || '')));
      }
    }

    sendAudio(base64PCM16) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const payload = {
        realtime_input: {
          media_chunks: [
            { mime_type: 'audio/pcm;rate=16000', data: base64PCM16 },
          ],
        },
      };
      this.ws.send(JSON.stringify(payload));
    }

    sendText(text) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const payload = {
        client_content: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turn_complete: true,
        },
      };
      this.ws.send(JSON.stringify(payload));
    }

    sendToolResponse(id, name, output) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const payload = {
        tool_response: {
          function_responses: [
            {
              id,
              name,
              response: typeof output === 'object' ? output : { output },
            },
          ],
        },
      };
      this.ws.send(JSON.stringify(payload));
    }

    disconnect() {
      this.connected = false;
      if (this.ws) {
        try { this.ws.close(); } catch (_) {}
        this.ws = null;
      }
    }
  }

  global.SochGeminiLiveClient = GeminiLiveClient;
})(window);
