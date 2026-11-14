# OMB Bulletin 23-01 metropolitan and micropolitan statistical areas

The reporting Regions (REQ-PI-044) are the official core-based statistical areas (CBSAs) of OMB Bulletin 23-01, July 21,
2023: 393 metropolitan and 542 micropolitan statistical areas. The two files below are the U.S. Census Bureau's
delineation files for that bulletin, kept byte for byte. They are free public data.

| File | Source | Last-Modified | Bytes | SHA-256 |
|---|---|---|---|---|
| `list1_2023.xlsx` | https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx | Fri, 04 Aug 2023 14:36:17 GMT | 143798 | `952c4b1e78acbb54e6ec9412434b7602fedacbf021736351a63c181bdb753629` |
| `list2_2023.xlsx` | https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list2_2023.xlsx | Fri, 04 Aug 2023 14:36:23 GMT | 79368 | `1e1091de28d1ad1423cebf18e7cdb6db4fbf2204fd357bc68c24e8261dcce161` |

Both were downloaded on November 14, 2026. List 1 names each CBSA's code, title, metropolitan or micropolitan type and
its counties. List 2 names each CBSA's principal cities.

`areas.json` is built from the two files by `build.py` (Python standard library only) and holds nothing else: each
area's code, title, type, counties (FIPS code, name and state) and principal cities (name and state), with the source
files' hashes. Run `python3 -I docs/reference/geography/omb-23-01/build.py --check` to confirm it matches them.

The app installs this list as one validated global reference release, `geography/omb-23-01`, whose manifest hash is the
SHA-256 of `areas.json`, with a `geography_dataset` item `omb-23-01` and one `geography_region` item per area, keyed
`omb-23-01/<CBSA code>` (`installGeographyRelease` in `packages/domain/src/organizations/geography.ts`). A planter's
typed place matches an area only where List 2 names it as a principal city. Nothing is geocoded, no street or coordinate
is used, and a place that matches more than one area is never resolved to the first.
