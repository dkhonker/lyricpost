class DataFetcher {
    constructor() {
        this.toHongKongTraditional = window.OpenCC?.Converter
            ? window.OpenCC.Converter({ from: 'cn', to: 'hk' })
            : (text) => text;
    }

    /**
     * Searches the key-free iTunes Search API for songs.
     *
     * @private
     * @param {string} term
     * @param {'artistTerm' | 'songTerm'} attribute
     * @param {number} limit
     * @returns {Promise<object[]>}
     */
    async searchItunes(term, attribute, limit) {
        const query = new URLSearchParams({
            term,
            country: 'HK',
            media: 'music',
            entity: 'song',
            attribute,
            limit: String(limit),
        });
        const response = await fetch(
            `https://itunes.apple.com/search?${query}`
        );

        if (!response.ok) {
            throw new Error(`iTunes Search returned HTTP ${response.status}`);
        }

        const result = await response.json();
        return result?.results || [];
    }

    /**
     * @private
     * @param {string} query
     * @returns {string[]}
     */
    getSearchAliases(query) {
        return [query, this.toHongKongTraditional(query)].filter(
            (value, index, values) => value && values.indexOf(value) === index
        );
    }

    /**
     * @private
     * @param {string} value
     * @returns {string}
     */
    normalize(value) {
        return String(value || '')
            .normalize('NFKC')
            .trim()
            .toLocaleLowerCase();
    }

    /**
     * Removes duplicate artist/track pairs while preserving result order.
     *
     * @private
     * @param {object[]} tracks
     * @returns {object[]}
     */
    deduplicateTracks(tracks) {
        const seen = new Set();

        return tracks.filter((track) => {
            const key = track.trackId
                ? String(track.trackId)
                : `${this.normalize(track.artistName)}|${this.normalize(
                      track.trackName
                  )}`;

            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    /**
     * @private
     * @param {object} track
     * @param {Set<string>} normalizedAliases
     * @returns {boolean}
     */
    matchesTrackTitle(track, normalizedAliases) {
        const title = this.normalize(track.trackName);
        return [...normalizedAliases].some((alias) => title.includes(alias));
    }

    /**
     * Converts an iTunes Search result into the Last.fm-like shape Song uses.
     *
     * @private
     * @param {object} track
     * @returns {Song}
     */
    toSong(track) {
        const artwork = String(track.artworkUrl100 || '').replace(
            /\d+x\d+bb/,
            '600x600bb'
        );
        const images = artwork
            ? [0, 1, 2, 3].map(() => ({ '#text': artwork }))
            : [];

        return new Song({
            name: track.trackName,
            duration: track.trackTimeMillis,
            artist: { name: track.artistName },
            album: { image: images },
        });
    }

    /**
     * Searches for songs by title, artist, or both.
     *
     * @private
     * @param {string} query
     * @param {number} limit
     * @param {'general' | 'song' | 'artist'} mode
     * @returns {Promise<Song[]>}
     */
    async getSongInfos(query, limit = 1, mode = 'general') {
        const aliases = this.getSearchAliases(query);
        const normalizedAliases = new Set(
            aliases.map((alias) => this.normalize(alias))
        );
        const broadLimit = Math.min(Math.max(limit * 8, limit), 50);
        let tracks = [];

        if (mode === 'song') {
            const resultSets = await Promise.all(
                aliases.map((alias) =>
                    this.searchItunes(alias, 'songTerm', broadLimit)
                )
            );
            tracks = this.deduplicateTracks(resultSets.flat())
                .filter((track) =>
                    this.matchesTrackTitle(track, normalizedAliases)
                )
                .slice(0, limit);
        } else if (mode === 'artist') {
            const resultSets = await Promise.all(
                aliases.map((alias) =>
                    this.searchItunes(alias, 'artistTerm', limit)
                )
            );
            const candidates = this.deduplicateTracks(resultSets.flat());
            const exact = candidates.filter((track) =>
                normalizedAliases.has(this.normalize(track.artistName))
            );
            tracks = (exact.length ? exact : candidates).slice(0, limit);
        } else {
            const [artistSets, songSets] = await Promise.all([
                Promise.all(
                    aliases.map((alias) =>
                        this.searchItunes(alias, 'artistTerm', limit)
                    )
                ),
                Promise.all(
                    aliases.map((alias) =>
                        this.searchItunes(alias, 'songTerm', broadLimit)
                    )
                ),
            ]);
            const artistTracks = this.deduplicateTracks(
                artistSets.flat()
            ).filter((track) =>
                normalizedAliases.has(this.normalize(track.artistName))
            );
            tracks = this.deduplicateTracks([
                ...artistTracks,
                ...this.deduplicateTracks(songSets.flat()).filter((track) =>
                    this.matchesTrackTitle(track, normalizedAliases)
                ),
            ]).slice(0, limit);
        }

        return tracks.map((track) => this.toSong(track));
    }

    /**
     * Searches for song lyrics on lrclib.
     *
     * @private
     * @param {string} artistName
     * @param {string} trackName
     * @returns {Promise<object | null>}
     */
    async getSongLyrics(artistName, trackName) {
        const query = new URLSearchParams({
            q: `${artistName} ${trackName}`,
        });
        const response = await fetch(`https://lrclib.net/api/search?${query}`, {
            method: 'GET',
        });
        const result = await response.json();
        const filteredResult = result.filter(
            (data) =>
                data.trackName.toLowerCase().trim() ===
                trackName.toLowerCase().trim()
        );

        return filteredResult[0] ?? result[0] ?? null;
    }
}
