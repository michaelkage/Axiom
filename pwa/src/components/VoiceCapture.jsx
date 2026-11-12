import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { Capacitor, registerPlugin } from '@capacitor/core';

const NativeIOS = registerPlugin('AxiomSecureStorage');
const useNativeIOS = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export default function VoiceCapture({ onTranscript, disabled = false, onError }) {
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState('');
  const recognitionRef = useRef(null);
  const nativeRef = useRef(null);

  useEffect(() => {
    if (disabled && recognitionRef.current) recognitionRef.current.stop();
    if (disabled && nativeRef.current) stopNative();
  }, [disabled]);

  useEffect(() => () => {
    recognitionRef.current?.stop?.();
    recognitionRef.current = null;
    stopNative();
  }, []);

  async function stopNative() {
    const active = nativeRef.current;
    if (!active) return;
    nativeRef.current = null;
    try { await active.resultListener?.remove?.(); } catch {}
    try { await active.errorListener?.remove?.(); } catch {}
    try { await NativeIOS.stopSpeech(); } catch {}
    setRecording(false);
    setInterim('');
  }

  async function toggle() {
    if (recording) {
      if (nativeRef.current) await stopNative();
      else recognitionRef.current?.stop?.();
      return;
    }
    if (useNativeIOS()) {
      try {
        const resultListener = await NativeIOS.addListener('speechResult', event => {
          const text = String(event?.text || '');
          if (event?.final && text.trim()) { onTranscript?.(text.trim()); setInterim(''); }
          else setInterim(text);
        });
        const errorListener = await NativeIOS.addListener('speechError', event => {
          onError?.('Voice capture failed: ' + String(event?.message || 'Unknown speech error'));
          void stopNative();
        });
        nativeRef.current = { resultListener, errorListener };
        await NativeIOS.startSpeech();
        setRecording(true);
        setInterim('');
      } catch (error) {
        await stopNative();
        onError?.('Could not start iOS speech recognition: ' + (error?.message || String(error)));
      }
      return;
    }
    if (!Recognition) {
      onError?.('Speech recognition is not available in this browser. Use Chrome on Android or type your prompt.');
      return;
    }
    try {
      const recognition = new Recognition();
      recognition.lang = navigator.language || 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => { setRecording(true); setInterim(''); };
      recognition.onresult = event => {
        let finalText = '';
        let partial = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result.isFinal) finalText += result[0]?.transcript || '';
          else partial += result[0]?.transcript || '';
        }
        if (finalText.trim()) onTranscript?.(finalText.trim());
        setInterim(partial);
      };
      recognition.onerror = event => {
        if (event.error !== 'no-speech' && event.error !== 'aborted') onError?.('Voice capture failed: ' + event.error + '.');
      };
      recognition.onend = () => { setRecording(false); setInterim(''); recognitionRef.current = null; };
      recognitionRef.current = recognition;
      recognition.start();
    } catch (error) {
      setRecording(false);
      onError?.('Could not start voice capture: ' + error.message);
    }
  }

  return <div className="flex items-center gap-2">
    <button type="button" onClick={toggle} disabled={disabled} aria-label={recording ? 'Stop voice dictation' : 'Start voice dictation'} aria-pressed={recording} title={(Recognition || useNativeIOS()) ? (recording ? 'Stop dictation' : 'Dictate prompt') : 'Speech recognition unavailable'} className={'w-11 h-11 grid place-items-center border ' + (recording ? 'border-red-400 bg-red-400/15 text-red-300' : 'border-white/10 bg-white/[.04] text-slate-300') + ' disabled:opacity-40'}>
      {recording ? <MicOff size={17}/> : <Mic size={17}/>}
    </button>
    {recording && <div className="flex items-center gap-2 min-w-0" role="status" aria-live="polite">
      <span className="flex items-center gap-0.5 h-6" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <span key={index} className="voice-wave-bar w-1 rounded-full bg-red-300" style={{ animationDelay: (index * 75) + 'ms' }}/>)}</span>
      <span className="text-[10px] text-red-200 truncate max-w-32">{interim || 'Listening…'}</span>
    </div>}
  </div>;
}
