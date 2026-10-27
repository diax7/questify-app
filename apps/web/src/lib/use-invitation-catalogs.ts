"use client";
import type { City, Interest } from "@questify/shared";
import { useEffect, useState } from "react";
import { readCities } from "#src/lib/cities.ts";
import { readInterests } from "#src/lib/interests.ts";
import { requestJson } from "#src/lib/post-json.ts";

type Catalogs = Readonly<{
  cities: readonly City[];
  interests: readonly Interest[];
  /** A list could not be read: the form then offers fewer choices and says so. */
  failed: boolean;
}>;

/** The seeded cities and interests (ADR-277, ADR-319), each read once. */
export function useInvitationCatalogs(): Catalogs {
  const [state, setState] = useState<Catalogs>({ cities: [], interests: [], failed: false });
  useEffect(() => {
    let current = true;
    void Promise.all([requestJson("GET", "/v1/cities"), requestJson("GET", "/v1/interests")]).then(
      ([cityAnswer, interestAnswer]) => {
        const cities = cityAnswer.ok ? readCities(cityAnswer.body) : undefined;
        const interests = interestAnswer.ok ? readInterests(interestAnswer.body) : undefined;
        if (current) {
          setState({
            cities: cities ?? [],
            interests: interests ?? [],
            failed: cities === undefined || interests === undefined,
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, []);
  return state;
}
