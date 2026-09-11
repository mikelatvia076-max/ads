/* =========================================================
   UNIVERSITY RUMOURS / CAMPUS NEWS
   API: NewsData.io
   API KEY: STORED SECURELY IN SERVER .env
   DOES NOT USE GROQ
========================================================= */

const rumoursContainer =
    document.getElementById("universityRumours");


/* =========================================================
   LOADING
========================================================= */

function showRumoursLoading() {

    if (!rumoursContainer) return;

    rumoursContainer.innerHTML = `
        <div class="rumours-loading">

            <div class="rumours-spinner"></div>

            <h3>Loading University Rumours...</h3>

            <p>
                Searching for the latest university,
                campus and student information.
            </p>

        </div>
    `;
}


/* =========================================================
   ERROR
========================================================= */

function showRumoursError(message) {

    if (!rumoursContainer) return;

    rumoursContainer.innerHTML = `

        <div class="rumours-error">

            <div class="rumours-error-icon">
                ⚠️
            </div>

            <h3>
                Unable to load university information
            </h3>

            <p>
                ${escapeRumourHTML(message)}
            </p>

            <button
                class="rumours-retry-btn"
                type="button"
                onclick="loadUniversityRumours()">

                Try Again

            </button>

        </div>

    `;
}


/* =========================================================
   LOAD UNIVERSITY RUMOURS
========================================================= */

async function loadUniversityRumours() {

    if (!rumoursContainer) {

        console.error(
            "Element #universityRumours was not found."
        );

        return;
    }


    showRumoursLoading();


    try {

        const response =
            await fetch(
                "/api/university-rumours"
            );


        if (!response.ok) {

            let errorMessage =
                "University news service failed.";

            try {

                const errorData =
                    await response.json();

                if (errorData.error) {

                    errorMessage =
                        errorData.error;
                }

            } catch {

                // Ignore JSON parsing error
            }


            throw new Error(
                errorMessage
            );
        }


        const data =
            await response.json();


        if (
            !data ||
            !Array.isArray(data.articles)
        ) {

            throw new Error(
                "Invalid response received from university news service."
            );
        }


        displayUniversityRumours(
            data.articles
        );


    } catch (error) {

        console.error(
            "University rumours error:",
            error
        );


        showRumoursError(
            error.message ||
            "There was a problem loading university information."
        );
    }
}


/* =========================================================
   VIDEO EMBEDDING

   NewsData.io includes a "video_url" field on articles that
   have an associated video. This can be a YouTube link, a
   Vimeo link, or a direct video file (.mp4 / .webm etc).

   This helper figures out how to embed whatever comes back.
========================================================= */

function getRumourVideoEmbed(videoUrl) {

    if (!videoUrl) return null;

    let parsed;

    try {

        parsed = new URL(videoUrl);

    } catch {

        return null;
    }

    const host =
        parsed.hostname.replace(/^www\./, "");


    /* ---------------- YOUTUBE ---------------- */

    if (
        host === "youtube.com" ||
        host === "m.youtube.com" ||
        host === "youtu.be"
    ) {

        let videoId = "";

        if (host === "youtu.be") {

            videoId = parsed.pathname.slice(1);

        } else if (parsed.searchParams.get("v")) {

            videoId = parsed.searchParams.get("v");

        } else if (parsed.pathname.startsWith("/embed/")) {

            videoId = parsed.pathname.split("/embed/")[1];

        } else if (parsed.pathname.startsWith("/shorts/")) {

            videoId = parsed.pathname.split("/shorts/")[1];
        }

        videoId = (videoId || "").split(/[?&/]/)[0];

        if (videoId) {

            return {
                kind: "iframe",
                src: `https://www.youtube.com/embed/${videoId}`
            };
        }

        return null;
    }


    /* ---------------- VIMEO ---------------- */

    if (host === "vimeo.com" || host === "player.vimeo.com") {

        const videoId =
            parsed.pathname
                .split("/")
                .filter(Boolean)
                .pop();

        if (videoId && /^\d+$/.test(videoId)) {

            return {
                kind: "iframe",
                src: `https://player.vimeo.com/video/${videoId}`
            };
        }

        return null;
    }


    /* ---------------- DIRECT VIDEO FILE ---------------- */

    if (/\.(mp4|webm|ogg|ogv|mov)(\?.*)?$/i.test(parsed.pathname)) {

        return {
            kind: "video",
            src: videoUrl
        };
    }


    /* ---------------- UNKNOWN — try a generic iframe ---------------- */

    return {
        kind: "iframe",
        src: videoUrl
    };
}


/* =========================================================
   DISPLAY UNIVERSITY RUMOURS
========================================================= */

function displayUniversityRumours(
    articles
) {

    if (!rumoursContainer) return;


    if (!articles.length) {

        rumoursContainer.innerHTML = `

            <div class="no-rumours">

                <h3>
                    No university information found
                </h3>

                <p>
                    No matching campus stories are
                    currently available.
                </p>

            </div>

        `;

        return;
    }


    rumoursContainer.innerHTML = "";


    articles.forEach(
        article => {

            const card =
                document.createElement(
                    "article"
                );


            card.className =
                "university-rumour-card";


            /* =================================================
               VIDEO / IMAGE

               If the article has a usable video_url, that is
               shown instead of the static image. Otherwise we
               fall back to image_url as before.
            ================================================= */

            let mediaHTML = "";

            const videoEmbed =
                getRumourVideoEmbed(
                    article.video_url
                );


            if (videoEmbed) {

                if (videoEmbed.kind === "video") {

                    mediaHTML = `

                        <div
                            class="rumour-video-wrapper"
                            style="position:relative;width:100%;aspect-ratio:16/9;background:#000;overflow:hidden;">

                            <video
                                class="rumour-video"
                                src="${escapeAttribute(
                                    videoEmbed.src
                                )}"
                                controls
                                preload="metadata"
                                style="width:100%;height:100%;display:block;"
                                onerror="
                                    this.closest('.rumour-video-wrapper').style.display='none';
                                ">
                            </video>

                        </div>

                    `;

                } else {

                    mediaHTML = `

                        <div
                            class="rumour-video-wrapper"
                            style="position:relative;width:100%;aspect-ratio:16/9;background:#000;overflow:hidden;">

                            <iframe
                                class="rumour-video-iframe"
                                src="${escapeAttribute(
                                    videoEmbed.src
                                )}"
                                title="University news video"
                                loading="lazy"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowfullscreen
                                style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;"
                                onerror="
                                    this.closest('.rumour-video-wrapper').style.display='none';
                                ">
                            </iframe>

                        </div>

                    `;
                }

            } else if (
                article.image_url
            ) {

                mediaHTML = `

                    <div
                        class="rumour-image-wrapper">

                        <img
                            class="rumour-image"
                            src="${escapeAttribute(
                                article.image_url
                            )}"
                            alt="University news"
                            loading="lazy"
                            onerror="
                                this.parentElement.style.display='none';
                            "
                        >

                    </div>

                `;
            }


            /* =================================================
               DATE
            ================================================= */

            const formattedDate =
                formatRumourDate(
                    article.pubDate
                );


            /* =================================================
               DESCRIPTION
            ================================================= */

            const description =
                article.description ||
                article.content ||
                "No description is available for this story.";


            /* =================================================
               SOURCE
            ================================================= */

            const source =
                article.source_name ||
                article.source_id ||
                "News source";


            /* =================================================
               URL
            ================================================= */

            const articleURL =
                article.link ||
                "";


            /* =================================================
               CARD HTML
            ================================================= */

            card.innerHTML = `

                ${mediaHTML}

                <div class="rumour-content">

                    <div class="rumour-meta">

                        <span
                            class="rumour-source">

                            ${escapeRumourHTML(
                                source
                            )}

                        </span>


                        <span
                            class="rumour-date">

                            ${escapeRumourHTML(
                                formattedDate
                            )}

                        </span>

                    </div>


                    <h3
                        class="rumour-title">

                        ${escapeRumourHTML(
                            article.title ||
                            "University News"
                        )}

                    </h3>


                    <p
                        class="rumour-description">

                        ${escapeRumourHTML(
                            shortenRumourText(
                                description,
                                450
                            )
                        )}

                    </p>


                    <div
                        class="rumour-footer">

                        <span
                            class="rumour-type">

                            ${
                                videoEmbed
                                ? "🎥 Video"
                                : "🎓 Campus News"
                            }

                        </span>


                        ${
                            articleURL
                            ?

                            `

                            <button
                                class="rumour-read-more"
                                type="button">

                                Read More
                                <span>→</span>

                            </button>

                            `

                            :

                            ""
                        }

                    </div>

                </div>

            `;


            /* =================================================
               READ MORE
            ================================================= */

            const readMoreButton =
                card.querySelector(
                    ".rumour-read-more"
                );


            if (
                readMoreButton &&
                articleURL
            ) {

                readMoreButton.addEventListener(
                    "click",
                    () => {

                        window.open(
                            articleURL,
                            "_blank",
                            "noopener,noreferrer"
                        );

                    }
                );

            }


            rumoursContainer.appendChild(
                card
            );

        }
    );
}


/* =========================================================
   DATE FORMAT
========================================================= */

function formatRumourDate(
    dateString
) {

    if (!dateString) {

        return "Date unavailable";
    }


    const date =
        new Date(
            dateString
        );


    if (
        isNaN(
            date.getTime()
        )
    ) {

        return dateString;
    }


    return date.toLocaleDateString(
        "en-KE",
        {
            year: "numeric",
            month: "long",
            day: "numeric"
        }
    );
}


/* =========================================================
   SHORTEN TEXT
========================================================= */

function shortenRumourText(
    text,
    maxLength
) {

    if (!text) return "";


    text =
        String(text)
            .replace(
                /\s+/g,
                " "
            )
            .trim();


    if (
        text.length <= maxLength
    ) {

        return text;
    }


    return (
        text
            .substring(
                0,
                maxLength
            )
            .trim() +
        "..."
    );
}


/* =========================================================
   HTML SECURITY
========================================================= */

function escapeRumourHTML(
    value
) {

    return String(
        value || ""
    )
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}


function escapeAttribute(
    value
) {

    return escapeRumourHTML(
        value
    );
}


/* =========================================================
   AUTO LOAD
========================================================= */

document.addEventListener(
    "DOMContentLoaded",
    () => {

        loadUniversityRumours();

    }
);


/* =========================================================
   REFRESH EVERY 3 HOURS

   Matched to the server's cache window (see
   UNIVERSITY_RUMOURS_CACHE_TIME in server.js). Polling more
   often than the server actually refreshes just wastes a
   request for the same cached data, and was part of what
   drove NewsData's rate limit into the ground.
========================================================= */

setInterval(
    () => {

        loadUniversityRumours();

    },
    3 * 60 * 60 * 1000
);


/* =========================================================
   MAKE FUNCTION AVAILABLE
========================================================= */

window.loadUniversityRumours =
    loadUniversityRumours;