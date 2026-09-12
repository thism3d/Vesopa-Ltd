// Reusable wrapper around the Microsoft Store submission API.
// Reference: https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions
//            https://learn.microsoft.com/en-us/windows/uwp/monetize/get-app-data
//
// Using this API costs nothing beyond the Partner Center developer account
// you already have — Azure AD tokens and the REST calls themselves are free.

import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { getAccessToken } from "./auth.js";

const BASE_URL = "https://manage.devcenter.microsoft.com/v1.0/my/applications";

export class StoreSubmissionClient {
  /**
   * @param {object} creds
   * @param {string} creds.tenantId
   * @param {string} creds.clientId
   * @param {string} creds.clientSecret
   */
  constructor(creds) {
    this.creds = creds;
  }

  async _authHeaders(extra = {}) {
    const token = await getAccessToken(this.creds);
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async _request(method, url, { body, headers } = {}) {
    const res = await fetch(url, {
      method,
      headers: { ...(await this._authHeaders()), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const json = text ? JSON.parse(text) : null;

    if (!res.ok) {
      const err = new Error(
        `Store API ${method} ${url} failed: ${res.status} ${res.statusText}`
      );
      err.status = res.status;
      err.body = json ?? text;
      throw err;
    }
    return json;
  }

  // ---- Apps -------------------------------------------------------------

  /** List every app in the Partner Center account. */
  listApplications() {
    return this._request("GET", BASE_URL);
  }

  /** Get one app's data (includes pending/last-published submission ids). */
  getApplication(storeId) {
    return this._request("GET", `${BASE_URL}/${storeId}`);
  }

  // ---- Submissions --------------------------------------------------------

  /**
   * Creates a new in-progress submission (a copy of the last published
   * submission). Returns the submission resource, including
   * `fileUploadUrl` (an Azure Blob SAS URL) used to upload packages/images.
   */
  createSubmission(storeId) {
    return this._request("POST", `${BASE_URL}/${storeId}/submissions`);
  }

  /** Fetch an existing submission by id. */
  getSubmission(storeId, submissionId) {
    return this._request(
      "GET",
      `${BASE_URL}/${storeId}/submissions/${submissionId}`
    );
  }

  /**
   * Replaces the submission's data (listings, pricing, packages, etc).
   * Pass the full submission object (typically what you got from
   * createSubmission/getSubmission, with your edits applied).
   */
  updateSubmission(storeId, submissionId, submissionData) {
    return this._request(
      "PUT",
      `${BASE_URL}/${storeId}/submissions/${submissionId}`,
      { body: submissionData }
    );
  }

  /** Commits the submission, sending it to the Store for ingestion. */
  commitSubmission(storeId, submissionId) {
    return this._request(
      "POST",
      `${BASE_URL}/${storeId}/submissions/${submissionId}/commit`
    );
  }

  /** Polls the processing status of a submission (CommitStarted, Certification, Published, ...). */
  getSubmissionStatus(storeId, submissionId) {
    return this._request(
      "GET",
      `${BASE_URL}/${storeId}/submissions/${submissionId}/status`
    );
  }

  /** Deletes an in-progress submission (cannot delete a published one). */
  deleteSubmission(storeId, submissionId) {
    return this._request(
      "DELETE",
      `${BASE_URL}/${storeId}/submissions/${submissionId}`
    );
  }

  // ---- Package flights ----------------------------------------------------
  //
  // A flight is a private release of the app to a named group of testers. It
  // goes through certification exactly like a public release, and it is the
  // only way to put a real Store build on a real till without every customer
  // getting it too: Manual publish holds a release back, but the moment it is
  // published it goes to everybody at once.
  //
  // The release path this gives us:
  //
  //   flight -> install on the office till -> test -> main submission (Manual)
  //   -> Publish now
  //
  // A flight submission is the same resource as a normal one -- same packages,
  // same status polling, same commit -- under a different URL. Everything in
  // examples/stage.js and examples/commit.js works against one by passing the
  // flight id through.

  /** Every flight on an app, newest first. Note Microsoft's odd URL: `listflights`. */
  listFlights(storeId) {
    return this._request("GET", `${BASE_URL}/${storeId}/listflights`);
  }

  /** One flight, including its current pending submission if it has one. */
  getFlight(storeId, flightId) {
    return this._request("GET", `${BASE_URL}/${storeId}/flights/${flightId}`);
  }

  /**
   * Create a flight.
   *
   * `groupIds` are Partner Center *flight group* ids — the groups of testers,
   * created in Partner Center because the API cannot make them. `rankHigherThan`
   * orders overlapping flights; left out, the new flight sits at the bottom,
   * which is what a single "Vesopa Testers" flight wants.
   */
  createFlight(storeId, { friendlyName, groupIds, rankHigherThan }) {
    const body = { friendlyName, groupIds };
    if (rankHigherThan) body.rankHigherThan = rankHigherThan;
    return this._request("POST", `${BASE_URL}/${storeId}/flights`, { body });
  }

  /** Removes a flight and any submission in progress on it. */
  deleteFlight(storeId, flightId) {
    return this._request("DELETE", `${BASE_URL}/${storeId}/flights/${flightId}`);
  }

  /** A new in-progress submission on a flight. Same shape as createSubmission. */
  createFlightSubmission(storeId, flightId) {
    return this._request(
      "POST",
      `${BASE_URL}/${storeId}/flights/${flightId}/submissions`
    );
  }

  getFlightSubmission(storeId, flightId, submissionId) {
    return this._request(
      "GET",
      `${BASE_URL}/${storeId}/flights/${flightId}/submissions/${submissionId}`
    );
  }

  updateFlightSubmission(storeId, flightId, submissionId, submissionData) {
    return this._request(
      "PUT",
      `${BASE_URL}/${storeId}/flights/${flightId}/submissions/${submissionId}`,
      { body: submissionData }
    );
  }

  commitFlightSubmission(storeId, flightId, submissionId) {
    return this._request(
      "POST",
      `${BASE_URL}/${storeId}/flights/${flightId}/submissions/${submissionId}/commit`
    );
  }

  getFlightSubmissionStatus(storeId, flightId, submissionId) {
    return this._request(
      "GET",
      `${BASE_URL}/${storeId}/flights/${flightId}/submissions/${submissionId}/status`
    );
  }

  deleteFlightSubmission(storeId, flightId, submissionId) {
    return this._request(
      "DELETE",
      `${BASE_URL}/${storeId}/flights/${flightId}/submissions/${submissionId}`
    );
  }

  /**
   * Polls getSubmissionStatus until it leaves the "in progress" states,
   * or until timeoutMs elapses. Returns the final status resource.
   */
  async waitForStatus(
    storeId,
    submissionId,
    { intervalMs = 30_000, timeoutMs = 30 * 60_000, flightId = null } = {}
  ) {
    const inProgress = new Set(["None", "CommitStarted", "PreProcessing"]);
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // A flight's status lives under its own URL. Passing `flightId` is the
      // only difference between watching a test release and a public one.
      const status = flightId
        ? await this.getFlightSubmissionStatus(storeId, flightId, submissionId)
        : await this.getSubmissionStatus(storeId, submissionId);
      if (!inProgress.has(status.status)) return status;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for submission ${submissionId} to leave state ${status.status}`
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // ---- File upload (packages, screenshots, etc.) -------------------------

  /**
   * Zips the given files (array of absolute paths, or {path, nameInZip})
   * and uploads the zip to the submission's fileUploadUrl (an Azure Blob
   * SAS URL). Uses a single-shot PUT Blob request, which supports blobs up
   * to 256 MB — fine for most app packages/images. For larger packages,
   * switch to the @azure/storage-blob SDK's block-upload APIs instead.
   */
  async zipAndUploadFiles(fileUploadUrl, files, zipOutputPath) {
    await this._zipFiles(files, zipOutputPath);
    await this._uploadBlockBlob(fileUploadUrl, zipOutputPath);
  }

  _zipFiles(files, zipOutputPath) {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipOutputPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);

      for (const f of files) {
        const filePath = typeof f === "string" ? f : f.path;
        const nameInZip =
          typeof f === "string" ? path.basename(f) : f.nameInZip ?? path.basename(f.path);
        archive.file(filePath, { name: nameInZip });
      }

      archive.finalize();
    });
  }

  async _uploadBlockBlob(sasUrl, filePath) {
    const data = await fs.promises.readFile(filePath);
    const res = await fetch(sasUrl, {
      method: "PUT",
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "Content-Length": String(data.length),
      },
      body: data,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Blob upload failed: ${res.status} ${res.statusText} ${text}`
      );
    }
  }
}
