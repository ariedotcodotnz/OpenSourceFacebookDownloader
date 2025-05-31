// This file provides illustrative structures for interacting with Facebook.
// WARNING: Facebook's internal APIs (especially GraphQL) change frequently.
// These examples are conceptual and will likely require significant adaptation
// and reverse-engineering of current Facebook network requests to work reliably.
// This involves inspecting XHR requests in your browser's developer tools on Facebook.

import { getOriginalNameFromUrl } from "./utils.js";

const COMMON_GRAPHQL_ENDPOINT = "/api/graphql/";

// Helper to get fb_dtsg token (essential for authenticated POST requests)
// This needs to be executed in the page's context, so typically via content script -> background.
async function getFbDtsg(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => {
                // Method 1: Look for it in a common input field
                const dtsgInput = document.querySelector('input[name="fb_dtsg"]');
                if (dtsgInput) return dtsgInput.value;

                // Method 2: Try to extract from inline JavaScript (more fragile)
                const scripts = Array.from(document.getElementsByTagName('script'));
                for (const script of scripts) {
                    if (script.textContent) {
                        const match = script.textContent.match(/"DTSGInitialData"\s*,\s*\[\s*]\s*,\s*{\s*"token"\s*:\s*"([^"]+)"/);
                        if (match && match[1]) return match[1];
                        const match2 = script.textContent.match(/"token"\s*:\s*"([^"]+)"\s*,\s*"async_get_token"/);
                        if (match2 && match2[1]) return match2[1];
                    }
                }
                return null;
            }
        });
        return results && results[0] ? results[0].result : null;
    } catch (e) {
        console.error("Error getting fb_dtsg:", e);
        return null;
    }
}

/**
 * Fetches photo URLs for a given Facebook album ID.
 * This is a conceptual representation. Actual GraphQL queries and parameters will vary.
 * @param {string} albumId The Facebook album ID.
 * @param {number} tabId The ID of the tab where the content script runs / for auth.
 * @param {string} albumNameFromContentScript Optional album name from content script.
 * @returns {Promise<{albumName: string, photos: Array<{id: string, url: string, originalName: string}>}>}
 */
export async function getPhotoUrlsForAlbum(albumId, tabId, albumNameFromContentScript) {
    console.log(`[API] Fetching album: ${albumId}`);

    const fbDtsg = await getFbDtsg(tabId);
    if (!fbDtsg) {
        console.warn("[API] fb_dtsg token not found. Using fallback scraping method.");
    }

    let allPhotos = [];
    let albumName = albumNameFromContentScript || `Album ${albumId}`;
    const photoIdsOnPage = new Set(); // To avoid duplicates from scraping multiple times if API fails

    // For most album IDs, we'll use the page scraping method as it's more reliable
    // Rather than attemping GraphQL which frequently changes
    console.log("[API] Using page scraping for album:", albumId);

    try {
        console.log(`[API] Executing scraping script in tab ${tabId} for album ${albumId}`);

        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: (currentAlbumId) => {
                console.log("[CONTENT] Starting album photo scraping for:", currentAlbumId);

                // Log all image-like elements for debugging
                const allImgs = document.querySelectorAll('img');
                console.log(`[CONTENT] Found ${allImgs.length} total images on page`);

                let scrapedAlbumName = `Album ${currentAlbumId}`;
                const titleElement = document.querySelector('h1, h2, [data-testid="album-title"], [role="heading"][aria-level="1"]');
                if (titleElement) scrapedAlbumName = titleElement.textContent.trim();
                console.log(`[CONTENT] Album name detected: ${scrapedAlbumName}`);

                // Expanded selectors to catch more photo elements
                const photoElements = Array.from(document.querySelectorAll(
                    'img[data-visualcompletion="media-vc-image"], ' + // Common image container
                    'a[href*="/photos/"] > img, ' +                   // Images within photo links
                    'div[data-visualcompletion="photo-layout"] img, ' + // Photos in grid layouts
                    'object[type="image/jpeg"], ' +                   // Embedded high-res objects
                    'img[data-imgperflogname="media_viewer_image"], ' +  // Images in the new media viewer
                    'img[src*="fbcdn.net"], ' +                      // Images from Facebook CDN
                    'img[class*="photo"], ' +                        // Class-based selection
                    'img[class*="image"]'                           // More class-based selection
                ));

                console.log(`[CONTENT] Found ${photoElements.length} potential photo elements`);

                const photos = photoElements
                    .map((img, index) => {
                        const rect = img.getBoundingClientRect();
                        // Filter out small images (likely icons, etc)
                        if (rect.width < 100 || rect.height < 100) {
                            return null;
                        }

                        let src = img.src;
                        let photoId = null;
                        let originalName = `photo_${index + 1}.jpg`;

                        // Try to get high-res from parent object or specific attributes
                        const parentObject = img.closest('object[type="image/jpeg"]');
                        if (parentObject && parentObject.data) src = parentObject.data;

                        const highResData = img.dataset.src ||
                            (img.dataset.imgperflogname === "media_viewer_image" && img.src);
                        if(highResData) src = highResData;

                        // Improve URL quality by removing Facebook's image downsizing parameters
                        src = src.replace(/\/[sp]\d+x\d+\//, '/');  // Remove /s640x480/ type pattern
                        src = src.replace(/_\d+x\d+/, '');          // Remove _640x480 type pattern

                        let anchor = img.closest('a');
                        if (anchor && anchor.href) {
                            const fbidMatch = anchor.href.match(/fbid=([\w.-]+)/);
                            if (fbidMatch && fbidMatch[1]) photoId = fbidMatch[1];

                            const photoPageMatch = anchor.href.match(/facebook\.com\/photo\/\?fbid=([\w.-]+)/) ||
                                anchor.href.match(/\/photos\/(?:pcb\.\d+\/)?([\w.-]+)/);
                            if (photoPageMatch && photoPageMatch[1]) photoId = photoPageMatch[1];
                        }

                        if (!photoId) { // Fallback ID
                            // Try to get from 'aria-labelledby' pointing to an ID
                            const labelledby = img.getAttribute('aria-labelledby');
                            if (labelledby) {
                                const labelElem = document.getElementById(labelledby);
                                if (labelElem && labelElem.id) photoId = labelElem.id;
                            }
                            if(!photoId) photoId = `scraped_${currentAlbumId}_${Date.now()}_${index}`;
                        }

                        originalName = (img.alt || `image_from_${currentAlbumId}_${index}`).substring(0,50).replace(/[^a-zA-Z0-9_.-]/g, '_') + (src.includes('.png') ? '.png' : '.jpg');

                        console.log(`[CONTENT] Photo ${index}: ID=${photoId}, size=${rect.width}x${rect.height}`);
                        return { id: photoId, url: src, originalName: originalName };
                    })
                    .filter(p => p !== null && p.url && !p.url.startsWith('data:image') && p.url.includes('fbcdn.net'));

                console.log(`[CONTENT] After filtering: ${photos.length} valid photos`);

                const uniquePhotos = [];
                const seenUrls = new Set();
                for (const photo of photos) {
                    if (!seenUrls.has(photo.url)) {
                        uniquePhotos.push(photo);
                        seenUrls.add(photo.url);
                    }
                }

                console.log(`[CONTENT] Final unique photos: ${uniquePhotos.length}`);

                // Log a few samples for debugging
                uniquePhotos.slice(0, 3).forEach((photo, i) => {
                    console.log(`[CONTENT] Sample photo ${i}: ${photo.id}, URL prefix: ${photo.url.substring(0, 50)}...`);
                });

                return { albumName: scrapedAlbumName, photos: uniquePhotos };
            },
            args: [albumId]
        });

        if (results && results[0] && results[0].result) {
            const { albumName: finalAlbumName, photos: finalPhotos } = results[0].result;
            console.log(`[API] Scraped ${finalPhotos.length} photos for ${finalAlbumName}.`);
            if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message); // check for errors

            try {
                chrome.runtime.sendMessage({
                    action: "albumPhotoCountUpdated",
                    data: { count: finalPhotos.length }
                });
            } catch (msgError) {
                console.warn("Could not send photo count update message:", msgError);
            }

            return { albumName: finalAlbumName, photos: finalPhotos };
        }
        throw new Error("Scraping did not yield results.");
    } catch (error) {
        console.error("[API] Error scraping photos from page:", error);

        // Fallback to an alternative method if we can't get photos with the main method
        console.log("[API] Attempting alternative scraping method");

        try {
            // Try a more direct DOM query with less filtering
            const alternativeResults = await chrome.scripting.executeScript({
                target: { tabId },
                func: (currentAlbumId) => {
                    // Just get all large images from Facebook CDN
                    const allImages = Array.from(document.querySelectorAll('img'))
                        .filter(img => {
                            const rect = img.getBoundingClientRect();
                            return img.src?.includes('fbcdn.net') && rect.width > 100 && rect.height > 100;
                        })
                        .map((img, index) => ({
                            id: `alt_${currentAlbumId}_${index}`,
                            url: img.src,
                            originalName: `photo_${index + 1}.jpg`
                        }));

                    console.log(`[CONTENT] Alternative method found ${allImages.length} images`);
                    return {
                        albumName: document.title?.replace(" | Facebook", "") || `Album ${currentAlbumId}`,
                        photos: allImages
                    };
                },
                args: [albumId]
            });

            if (alternativeResults && alternativeResults[0]?.result?.photos?.length > 0) {
                const { albumName: altAlbumName, photos: altPhotos } = alternativeResults[0].result;
                console.log(`[API] Alternative method found ${altPhotos.length} photos`);
                return { albumName: altAlbumName, photos: altPhotos };
            }
        } catch (altError) {
            console.error("[API] Alternative scraping also failed:", altError);
        }

        throw new Error("Failed to scrape photos. Facebook's structure might have changed or the album is private/empty.");
    }
}

/**
 * Fetches photo URLs from a Facebook post.
 * @param {Array<{id: string, url: string, originalName?: string}>} photoDataFromContentScript
 * @param {string} postId
 * @param {number} tabId
 * @returns {Promise<Array<{id: string, url: string, originalName: string}>>}
 */
export async function getPhotoUrlsFromPost(photoDataFromContentScript, postId, tabId) {
    console.log(`[API] Processing photos for post: ${postId}`);

    // In this version, we primarily rely on the content script for initial URLs.
    // A more advanced version would iterate `photoDataFromContentScript`
    // and for each `photo.id`, try to fetch a higher-resolution version
    // using a GraphQL query similar to the single photo viewer.

    // For now, we'll just attempt to "upgrade" URLs if they look like thumbnails.
    const processedPhotos = [];
    for (const photo of photoDataFromContentScript) {
        let bestUrl = photo.url;

        // Improve URL quality by removing Facebook's image downsizing parameters
        bestUrl = bestUrl.replace(/\/[sp]\d+x\d+\//, '/'); // Remove /s160x160/ or /p160x160/ pattern
        bestUrl = bestUrl.replace(/_[a-z]\d+x\d+(_\w+)?\./, '.'); // Remove _s160x160_abcd. pattern

        // Attempt to improve photo URL by executing script in the tab context
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: (photoId, currentUrl) => {
                    // Try to find a better version of this specific photo
                    console.log(`[CONTENT] Looking for better version of photo ${photoId}`);

                    // Look for image elements that might have this photo's ID in parent links
                    const potentialMatches = Array.from(document.querySelectorAll('img'))
                        .filter(img => {
                            const parent = img.closest(`a[href*="${photoId}"]`);
                            return parent !== null && img.src?.includes('fbcdn.net');
                        });

                    if (potentialMatches.length > 0) {
                        // Sort by area to get the largest version
                        potentialMatches.sort((a, b) => {
                            const aRect = a.getBoundingClientRect();
                            const bRect = b.getBoundingClientRect();
                            return (bRect.width * bRect.height) - (aRect.width * aRect.height);
                        });

                        const bestMatch = potentialMatches[0];
                        console.log(`[CONTENT] Found better version with size ${bestMatch.width}x${bestMatch.height}`);
                        return bestMatch.src;
                    }

                    // If no match found, return the existing URL
                    return currentUrl;
                },
                args: [photo.id, bestUrl]
            });

            if (results && results[0] && results[0].result) {
                bestUrl = results[0].result;
            }
        } catch (error) {
            console.warn(`[API] Could not execute script to find better photo version:`, error);
            // Continue with the existing URL
        }

        processedPhotos.push({
            id: photo.id,
            url: bestUrl,
            originalName: photo.originalName || getOriginalNameFromUrl(bestUrl) || `${photo.id}.jpg`
        });
    }

    console.log(`[API] Processed ${processedPhotos.length} photos for post`);
    return processedPhotos;
}

/**
 * Placeholder to get the highest resolution URL for a single photo ID.
 * @param {string} photoId
 * @param {number} tabId
 * @returns {Promise<{url: string, originalName?: string} | null>}
 */
export async function getSinglePhotoHighestResUrl(photoId, tabId) {
    console.log(`[API] Attempting to get highest res for photo: ${photoId}`);

    try {
        // Execute script in the tab to find the best version of this photo
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: (currentPhotoId) => {
                console.log(`[CONTENT] Looking for highest resolution of single photo ${currentPhotoId}`);

                // Start with the main image in a photo viewer
                let bestImageElement = document.querySelector('img[data-imgperflogname="media_viewer_image"]');

                if (!bestImageElement) {
                    // Fallback to any large Facebook CDN image
                    const allImages = Array.from(document.querySelectorAll('img[src*="fbcdn.net"]'))
                        .filter(img => {
                            const rect = img.getBoundingClientRect();
                            return rect.width > 200 && rect.height > 200;
                        });

                    // Sort by area to get the largest
                    if (allImages.length > 0) {
                        allImages.sort((a, b) => {
                            const aRect = a.getBoundingClientRect();
                            const bRect = b.getBoundingClientRect();
                            return (bRect.width * bRect.height) - (aRect.width * aRect.height);
                        });

                        bestImageElement = allImages[0];
                    }
                }

                if (bestImageElement) {
                    // Try to improve the URL by removing Facebook's image downsizing parameters
                    let url = bestImageElement.src;
                    url = url.replace(/\/[sp]\d+x\d+\//, '/');
                    url = url.replace(/_[a-z]\d+x\d+(_\w+)?\./, '.');

                    return {
                        url: url,
                        alt: bestImageElement.alt || '',
                        width: bestImageElement.width,
                        height: bestImageElement.height
                    };
                }

                return null;
            },
            args: [photoId]
        });

        if (results && results[0] && results[0].result) {
            const { url, alt } = results[0].result;
            const originalName = alt
                ? alt.substring(0, 80).replace(/[^a-zA-Z0-9_.\-]/g, '_').replace(/_+/g, '_')
                : getOriginalNameFromUrl(url) || `${photoId}.jpg`;

            return { url, originalName };
        }
    } catch (error) {
        console.warn(`[API] Failed to get high-res for ${photoId}:`, error);
    }

    // If we couldn't get a better version, return null and let the caller use the existing URL
    return null;
}