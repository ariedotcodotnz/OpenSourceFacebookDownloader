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
 * @param {AbortSignal} signal - AbortSignal for cancelling the fetch.
 * @returns {Promise<{albumName: string, photos: Array<{id: string, url: string, originalName: string}>}>}
 */
export async function getPhotoUrlsForAlbum(albumId, tabId, albumNameFromContentScript, signal) {
    if (signal && signal.aborted) throw { name: 'AbortError', message: 'Fetch aborted' };
    console.log(`[API] Fetching album: ${albumId}`);

    const fbDtsg = await getFbDtsg(tabId);
    if (!fbDtsg) {
        console.warn("[API] fb_dtsg token not found. API calls might fail.");
        // Depending on the FB page, some GET requests might work without it for public data
    }

    let allPhotos = [];
    let albumName = albumNameFromContentScript || `Album ${albumId}`;
    let afterCursor = null;
    let hasNextPage = true;
    const photoIdsOnPage = new Set(); // To avoid duplicates from scraping multiple times if API fails

    // Try a more robust approach if albumId looks like a real FB ID (numeric or fbid.XXX)
    // If albumId is a pseudo-ID like "scraped_album_..." then scraping is the only option.
    const isLikelyRealAlbumId = /^\d+$/.test(albumId) || albumId.startsWith("fbid.");

    if (isLikelyRealAlbumId) {
        console.log("[API] Attempting GraphQL fetch for album:", albumId);
        try {
            while (hasNextPage) {
                if (signal && signal.aborted) throw { name: 'AbortError', message: 'Fetch aborted' };

                // PLACEHOLDER: This is where you'd construct your GraphQL query.
                // You'd need to find the correct `doc_id` or query hash for fetching album photos
                // and the correct variables structure.
                // Example of what the variables *might* look like:
                const variables = {
                    id: albumId,
                    after: afterCursor,
                    first: 50, // Number of photos per page
                    // ... other necessary scale, media_type parameters
                    scale: 3, // Try to get a decent resolution
                };

                // Example doc_id (THESE ARE EXAMPLES AND WILL LIKELY NOT WORK, YOU NEED TO FIND CURRENT ONES)
                const ALBUM_PHOTOS_DOC_ID = "12345678901234567"; // Replace with actual doc_id

                const formData = new URLSearchParams();
                formData.append("fb_dtsg", fbDtsg || "");
                formData.append("variables", JSON.stringify(variables));
                formData.append("doc_id", ALBUM_PHOTOS_DOC_ID);
                // Add other form data parameters FB uses like `server_timestamps: true`, etc.

                const response = await fetch(COMMON_GRAPHQL_ENDPOINT, {
                    method: "POST",
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: formData.toString(),
                    signal
                });

                if (signal.aborted) throw { name: 'AbortError', message: 'Fetch aborted' };

                if (!response.ok) {
                    throw new Error(`GraphQL request failed with status ${response.status}`);
                }
                const jsonResponse = await response.json();

                // PLACEHOLDER: Parse the GraphQL response. Structure varies greatly.
                // You need to inspect the actual Facebook response to map this correctly.
                // Example structure (highly likely to be different):
                const albumDataNode = jsonResponse.data?.node || jsonResponse.data?.album || jsonResponse.data?.media_set;
                if (albumDataNode && albumDataNode.name && !albumNameFromContentScript) { // Update album name if found
                    albumName = albumDataNode.name.text || albumDataNode.name;
                }

                const photoEdges = albumDataNode?.photos?.edges || albumDataNode?.media?.edges || [];
                const pageInfo = albumDataNode?.photos?.page_info || albumDataNode?.media?.page_info;

                for (const edge of photoEdges) {
                    if (edge && edge.node) {
                        const photoNode = edge.node;
                        const id = photoNode.id;
                        // Try to find the best quality image URL
                        const imageUrl = photoNode.image?.uri || photoNode.image_highres?.uri || photo.large_image?.uri || photoNode.url;
                        const originalName = getOriginalNameFromUrl(imageUrl || `photo_${id}.jpg`);
                        if (id && imageUrl && !photoIdsOnPage.has(id)) {
                            allPhotos.push({ id, url: imageUrl, originalName });
                            photoIdsOnPage.add(id);
                        }
                    }
                }
                if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message); // check for errors
                chrome.runtime.sendMessage({ action: "albumPhotoCountUpdated", data: { count: allPhotos.length } });


                hasNextPage = pageInfo?.has_next_page || false;
                afterCursor = pageInfo?.end_cursor || null;

                if (!hasNextPage || allPhotos.length > 5000) { // Safety break for very large albums
                    console.warn("[API] Max photos fetched or no next page for album:", albumId);
                    break;
                }
                // Respectful delay
                await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
            }
            console.log(`[API] Fetched ${allPhotos.length} photos via GraphQL for album ${albumName}`);
            return { albumName, photos: allPhotos };

        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.warn(`[API] GraphQL fetch for album ${albumId} failed, falling back to page scraping. Error:`, error);
            // Fallback to scraping if API fails
        }
    }

    // Fallback to scraping if not a likely real album ID or if API attempt fails
    console.log("[API] Using page scraping for album/collection:", albumId);
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: (currentAlbumId) => {
                let scrapedAlbumName = `Album ${currentAlbumId}`;
                const titleElement = document.querySelector('h1, h2, [data-testid="album-title"], [role="heading"][aria-level="1"]') ;
                if (titleElement) scrapedAlbumName = titleElement.textContent.trim();

                // More robust selectors
                const photoElements = Array.from(document.querySelectorAll(
                    'img[data-visualcompletion="media-vc-image"], ' + // Common image container
                    'a[href*="/photos/"] > img, ' +                  // Images within photo links
                    'div[data-visualcompletion="photo-layout"] img, ' + // Photos in grid layouts
                    'object[type="image/jpeg"], ' +                   // Embedded high-res objects
                    'img[data-imgperflogname="media_viewer_image"]'   // Images in the new media viewer
                ));

                const photos = photoElements
                    .map((img, index) => {
                        let src = img.src;
                        let photoId = null;
                        let originalName = `photo_${index + 1}.jpg`;

                        // Try to get high-res from parent object or specific attributes
                        const parentObject = img.closest('object[type="image/jpeg"]');
                        if (parentObject && parentObject.data) src = parentObject.data;

                        const highResData = img.dataset.src || img.dataset.imgperflogname === "media_viewer_image" && img.src;
                        if(highResData) src = highResData;

                        let anchor = img.closest('a');
                        if (anchor && anchor.href) {
                            const fbidMatch = anchor.href.match(/fbid=([\w.-]+)/);
                            if (fbidMatch && fbidMatch[1]) photoId = fbidMatch[1];

                            const photoPageMatch = anchor.href.match(/facebook\.com\/photo\/\?fbid=([\w.-]+)/) || anchor.href.match(/\/photos\/(?:pcb\.\d+\/)?([\w.-]+)/);
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

                        return { id: photoId, url: src, originalName: originalName };
                    })
                    .filter(p => p.url && !p.url.startsWith('data:image') && p.url.includes('fbcdn.net'));

                const uniquePhotos = [];
                const seenUrls = new Set();
                for (const photo of photos) {
                    if (!seenUrls.has(photo.url)) {
                        uniquePhotos.push(photo);
                        seenUrls.add(photo.url);
                    }
                }
                return { albumName: scrapedAlbumName, photos: uniquePhotos };
            },
            args: [albumId]
        });

        if (signal.aborted) throw { name: 'AbortError', message: 'Fetch aborted' };

        if (results && results[0] && results[0].result) {
            const { albumName: finalAlbumName, photos: finalPhotos } = results[0].result;
            console.log(`[API] Scraped ${finalPhotos.length} photos for ${finalAlbumName}.`);
            if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message); // check for errors
            chrome.runtime.sendMessage({ action: "albumPhotoCountUpdated", data: { count: finalPhotos.length } });
            return { albumName: finalAlbumName, photos: finalPhotos };
        }
        throw new Error("Scraping did not yield results.");
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.error("[API] Error scraping photos from page:", error);
        throw new Error("Failed to scrape photos. Facebook's structure might have changed or the album is private/empty.");
    }
}

/**
 * Fetches photo URLs from a Facebook post.
 * @param {Array<{id: string, url: string, originalName?: string}>} photoDataFromContentScript
 * @param {string} postId
 * @param {number} tabId
 * @param {AbortSignal} signal
 * @returns {Promise<Array<{id: string, url: string, originalName: string}>>}
 */
export async function getPhotoUrlsFromPost(photoDataFromContentScript, postId, tabId, signal) {
    if (signal && signal.aborted) throw { name: 'AbortError', message: 'Fetch aborted' };
    console.log(`[API] Processing photos for post: ${postId}`);

    // In this version, we primarily rely on the content script for initial URLs.
    // A more advanced version would iterate `photoDataFromContentScript`
    // and for each `photo.id`, try to fetch a higher-resolution version
    // using a GraphQL query similar to the single photo viewer.

    // For now, we'll just attempt to "upgrade" URLs if they look like thumbnails.
    const processedPhotos = [];
    for (const photo of photoDataFromContentScript) {
        if (signal.aborted) throw { name: 'AbortError', message: 'Fetch aborted' };
        let bestUrl = photo.url;
        // Example: try to remove Facebook's image resizing parameters like _s160x160_ or /p160x160/
        bestUrl = bestUrl.replace(/\/[sp]\d+x\d+\//, '/').replace(/_[a-z]\d+x\d+(_\w+)?\./, '.');

        // Hypothetically, here you could make an API call for each photo.id if needed
        // const highResData = await getSinglePhotoHighestResUrl(photo.id, tabId, signal);
        // if (highResData && highResData.url) bestUrl = highResData.url;

        processedPhotos.push({
            id: photo.id,
            url: bestUrl,
            originalName: photo.originalName || getOriginalNameFromUrl(bestUrl) || `${photo.id}.jpg`
        });
    }
    return processedPhotos;
}

/**
 * Placeholder to get the highest resolution URL for a single photo ID.
 * @param {string} photoId
 * @param {number} tabId
 * @param {AbortSignal} signal
 * @returns {Promise<{url: string, originalName?: string} | null>}
 */
export async function getSinglePhotoHighestResUrl(photoId, tabId, signal) {
    if (signal && signal.aborted) throw { name: 'AbortError', message: 'Fetch aborted' };
    console.log(`[API] Attempting to get highest res for photo: ${photoId}`);

    // This would typically involve a GraphQL query with the photoId.
    // The query would request various image resolutions, and you'd pick the largest.
    // Example (conceptual, actual doc_id/variables will differ):
    /*
    const fbDtsg = await getFbDtsg(tabId);
    const variables = { photoId: photoId, scale: 3 }; // scale can be 1, 1.5, 2, 3, 4 etc.
    const PHOTO_DETAILS_DOC_ID = "09876543210987654"; // Replace with actual doc_id

    const formData = new URLSearchParams();
    formData.append("fb_dtsg", fbDtsg || "");
    formData.append("variables", JSON.stringify(variables));
    formData.append("doc_id", PHOTO_DETAILS_DOC_ID);

    try {
        const response = await fetch(COMMON_GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData.toString(),
            signal
        });
        if (!response.ok) throw new Error(`GraphQL for photo details failed: ${response.status}`);
        const jsonResponse = await response.json();

        const photoNode = jsonResponse.data?.node || jsonResponse.data?.photo;
        if (photoNode) {
            const imageUrl = photoNode.image?.uri || photoNode.image_highres?.uri || photoNode.full_image?.uri;
            const originalName = getOriginalNameFromUrl(imageUrl);
             if (imageUrl) return { url: imageUrl, originalName };
        }
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.warn(`[API] Failed to get high-res for ${photoId}:`, error);
    }
    */
    // Fallback: if the provided photo.url from content script is used for single download
    return null;
}