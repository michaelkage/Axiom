/**
 * Consume a newline-delimited JSON response stream in order.
 * Handles UTF-8 characters split across network chunks and a final record
 * without a trailing newline.
 */
export async function consumeNdjsonStream(response, onRecord) {
  if (!response?.body?.getReader) {
    throw new Error('Streaming response body unavailable');
  }
  if (typeof onRecord !== 'function') {
    throw new TypeError('onRecord must be a function');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lineNumber = 0;

  const consumeLine = async line => {
    lineNumber += 1;
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error('Invalid NDJSON on line ' + lineNumber + ': ' + error.message);
    }
    await onRecord(record);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) await consumeLine(line.replace(/\r$/, ''));
    }

    // Flush any buffered UTF-8 bytes before parsing the final unterminated line.
    buffer += decoder.decode();
    if (buffer.trim()) await consumeLine(buffer.replace(/\r$/, ''));
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
}
