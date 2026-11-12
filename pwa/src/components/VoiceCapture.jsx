import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';

const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export default function VoiceCapture({ onTranscript, disabled = false, onError }) {
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState('');
  const recognitionRef = useRef(null);

  useEffect(() => {
    if (disabled && recognitionRef.current) recognitionRef.current.stop();
  }, [disabled]);

  useEffect(() => () => {
    recognitionRef.current?.stop?.();
    recognitionRef.current = null;
  }, []);

  function toggle() {
    if (recording) {
      recognitionRef.current?.stop?.();
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
    <button type="button" onClick={toggle} disabled={disabled} aria-label={recording ? 'Stop voice dictation' : 'Start voice dictation'} aria-pressed={recording} title={Recognition ? (recording ? 'Stop dictation' : 'Dictate prompt') : 'Speech recognition unavailable'} className={'w-11 h-11 grid place-items-center border ' + (recording ? 'border-red-400 bg-red-400/15 text-red-300' : 'border-white/10 bg-white/[.04] text-slate-300') + ' disabled:opacity-40'}>
      {recording ? <MicOff size={17}/> : <Mic size={17}/>}
    </button>
    {recording && <div className="flex items-center gap-2 min-w-0" role="status" aria-live="polite">
      <span className="flex items-center gap-0.5 h-6" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <span key={index} className="voice-wave-bar w-1 rounded-full bg-red-300" style={{ animationDelay: (index * 75) + 'ms' }}/>)}</span>
      <span className="text-[10px] text-red-200 truncate max-w-32">{interim || 'Listening…'}</span>
    </div>}
  </div>;
}
