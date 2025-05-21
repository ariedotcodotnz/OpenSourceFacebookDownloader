/**
 * Sanitizes a filename by removing or replacing invalid characters.
 * @param {string} filename - The original filename.
 * @returns {string} The sanitized filename.
 */
export function sanitizeFilename(filename) {
    if (!filename || typeof filename !== 'string') {
        return `default_filename_${Date.now()}`;
    }
    // Remove or replace characters that are invalid in Windows/Mac/Linux filenames
    let sanitized = filename
        .replace(/[<>:"\/\\|?*\x00-\x1F\x7F~#%&{}$!@`+=]/g, '_') // Expanded set of problematic chars
        .replace(/\.\.+/g, '.') // Avoid multiple consecutive dots
        .replace(/^\.+|\.+$/g, '_') // Avoid leading/trailing dots
        .replace(/\s+/g, '_')    // Replace spaces with underscore for better compatibility
        .replace(/_{2,}/g, '_'); // Replace multiple underscores with single

    // Limit length
    const maxLength = 180; // Slightly more conservative for full paths
    if (sanitized.length > maxLength) {
        const extensionMatch = sanitized.match(/\.[^.]+$/);
        const extension = extensionMatch ? extensionMatch[0] : '';
        const nameWithoutExtension = extension ? sanitized.substring(0, sanitized.length - extension.length) : sanitized;
        sanitized = nameWithoutExtension.substring(0, maxLength - extension.length) + extension;
    }
    if (sanitized.length === 0 || sanitized === '.' || sanitized === '..') {
        return `downloaded_file_${Date.now()}`;
    }
    // Ensure common reserved names are avoided (Windows)
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reservedNames.test(sanitized.split('.')[0])) {
        sanitized = `_${sanitized}`;
    }

    return sanitized;
}

/**
 * Applies tokens to a filename/foldername rule.
 * @param {string} rule - The rule string with placeholders like {token_name}.
 * @param {object} data - An object containing key-value pairs for tokens.
 * @returns {string} The rule string with tokens replaced.
 */
export function applyTokenToFilename(rule, data) {
    let result = rule;
    for (const token in data) {
        if (data.hasOwnProperty(token)) {
            // Token values should be strings. Sanitize them individually before inserting.
            // This is a light sanitization for path components; full sanitization happens on the final string.
            const tokenValue = String(data[token] === null || data[token] === undefined ? '' : data[token])
                .replace(/[<>:"\/\\|?*]/g, '_'); // Basic sanitization for token values

            result = result.replace(new RegExp(`{${token}}`, 'g'), tokenValue);
        }
    }
    // Replace any unfulfilled tokens with empty string or a placeholder
    result = result.replace(/{[^}]+}/g, '').trim();
    // Remove multiple consecutive underscores/hyphens that might result from empty tokens
    result = result.replace(/__+/g, '_').replace(/--+/g, '-').replace(/[-_]{2,}/g, '_');
    result = result.replace(/^[-_]+|[-_]+$/g, ''); // Trim leading/trailing separators

    return result || `default_name_${Date.now()}`; // Fallback if rule results in empty string
}


/**
 * Extracts the original filename from a URL, trying to get a meaningful name.
 * @param {string} urlString - The URL to extract filename from.
 * @returns {string} The extracted filename or a default name.
 */
export function getOriginalNameFromUrl(urlString) {
    try {
        const url = new URL(urlString);
        let pathname = url.pathname;

        // Clean common Facebook CDN patterns that aren't part of the actual filename
        pathname = pathname.replace(/^\/[vtf]\d+(\.\d+-\d+)?(\.\d+)?\//, ''); // e.g. /v/t39.30808-6/ or /t1.6435-9/
        pathname = pathname.replace(/^\/p\d+x\d+\//, ''); // e.g. /p160x160/
        pathname = pathname.replace(/^\/s\d+x\d+\//, ''); // e.g. /s160x160/

        const segments = pathname.split('/');
        let filename = segments.pop() || '';

        // If filename is still generic or seems like a hash without extension
        if (filename.length > 70 || !filename.includes('.') || filename.startsWith('ATL') || /^[a-f0-9_]+$/.test(filename.split('.')[0])) {
            const searchParams = new URLSearchParams(url.search);
            // Try to get a more descriptive name from 'oe' or '_nc_ht' hash if present
            // These are often part of FB CDN urls and can be more unique than a generic "scontent.jpg"
            let potentialName = searchParams.get('oe') ||
                (searchParams.get('_nc_ht') ? searchParams.get('_nc_ht').split('-')[1] : null) || // e.g. _nc_ht=scontent.fsub6-1
                searchParams.get('oh'); // Last resort CDN hash

            if (potentialName) {
                // Attempt to determine extension from blob or mime type if possible, else default
                let extension = ".jpg"; // default
                if (url.pathname.toLowerCase().endsWith('.png')) extension = '.png';
                else if (url.pathname.toLowerCase().endsWith('.gif')) extension = '.gif';
                else if (url.pathname.toLowerCase().endsWith('.webp')) extension = '.webp';

                filename = `${potentialName}${extension}`;
            } else if (!filename.includes('.')) {
                filename = `image_${Date.now()}.jpg`; // Ultimate fallback
            }
        }
        if (!filename.includes('.')) { // Ensure an extension
            filename += '.jpg';
        }

        return decodeURIComponent(filename);
    } catch (error) {
        console.warn("Could not parse URL for filename:", urlString, error);
        return `photo_${Date.now()}.jpg`; // Fallback
    }
}