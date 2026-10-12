export const REPORT_META = /* GraphQL */ `
  query ReportMeta($code: String!) {
    reportData {
      report(code: $code) {
        code
        title
        startTime
        endTime
        zone {
          id
          name
        }
        fights(killType: Encounters) {
          id
          encounterID
          name
          difficulty
          kill
          startTime
          endTime
          bossPercentage
          fightPercentage
          friendlyPlayers
        }
        masterData {
          actors(type: "Player") {
            id
            name
            type
            subType
            server
          }
        }
      }
    }
  }
`;

export const REPORT_TABLE = /* GraphQL */ `
  query ReportTable(
    $code: String!
    $fightIDs: [Int]!
    $dataType: TableDataType!
    $sourceID: Int
    $hostilityType: HostilityType
  ) {
    reportData {
      report(code: $code) {
        table(
          fightIDs: $fightIDs
          dataType: $dataType
          sourceID: $sourceID
          hostilityType: $hostilityType
          startTime: 0
          endTime: 99999999
        )
      }
    }
  }
`;

export const REPORT_EVENTS = /* GraphQL */ `
  query ReportEvents(
    $code: String!
    $fightIDs: [Int]!
    $dataType: EventDataType!
    $sourceID: Int
    $targetID: Int
    $hostilityType: HostilityType
    $startTime: Float!
    $endTime: Float!
  ) {
    reportData {
      report(code: $code) {
        events(
          fightIDs: $fightIDs
          dataType: $dataType
          sourceID: $sourceID
          targetID: $targetID
          hostilityType: $hostilityType
          startTime: $startTime
          endTime: $endTime
          limit: 10000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

/**
 * Talent selections for every player in a fight. `talentTree` entries carry the
 * same ids that ranking rows expose as `talentID`, so the two are directly
 * comparable.
 */
export const COMBATANT_INFO = /* GraphQL */ `
  query CombatantInfo($code: String!, $fightIDs: [Int]!) {
    reportData {
      report(code: $code) {
        events(
          fightIDs: $fightIDs
          dataType: CombatantInfo
          startTime: 0
          endTime: 99999999
          limit: 100
        ) {
          data
        }
      }
    }
  }
`;

export const CHARACTER_RANKINGS = /* GraphQL */ `
  query Rankings(
    $encounterID: Int!
    $className: String
    $specName: String
    $difficulty: Int
    $metric: CharacterRankingMetricType
    $page: Int
  ) {
    worldData {
      encounter(id: $encounterID) {
        id
        name
        characterRankings(
          className: $className
          specName: $specName
          difficulty: $difficulty
          metric: $metric
          page: $page
          # Returns each ranked player's full talent selection inline, for all
          # 100 rows, at no extra query cost. This is what makes it possible to
          # match hero-talent builds without a spell database.
          includeCombatantInfo: true
        )
      }
    }
  }
`;

/**
 * A damage time series for a fight, bucketed by WCL into ~240 points. Summed
 * cumulatively and scaled by the health the pull actually removed, this
 * reconstructs the boss's health curve without needing its hit points.
 */
export const REPORT_GRAPH = /* GraphQL */ `
  query ReportGraph($code: String!, $fightIDs: [Int]!, $startTime: Float!, $endTime: Float!) {
    reportData {
      report(code: $code) {
        graph(
          fightIDs: $fightIDs
          dataType: DamageDone
          hostilityType: Friendlies
          startTime: $startTime
          endTime: $endTime
        )
      }
    }
  }
`;

/**
 * Every actor (pets and NPCs too, so pet damage folds into its owner and enemy
 * targets are recognisable) and every ability with its school mask in `type`.
 * Separate from REPORT_META so that document's hash, and so its cache, is untouched.
 */
export const REPORT_ACTORS_ABILITIES = /* GraphQL */ `
  query ReportActorsAbilities($code: String!) {
    reportData {
      report(code: $code) {
        masterData {
          actors {
            id
            name
            type
            subType
            petOwner
          }
          abilities {
            gameID
            name
            type
          }
        }
      }
    }
  }
`;

/** One aura's apply/remove events, by ability id — a few hundred rows instead of every debuff in the fight. */
export const AURA_EVENTS = /* GraphQL */ `
  query AuraEvents(
    $code: String!
    $fightIDs: [Int]!
    $dataType: EventDataType!
    $abilityID: Float!
    $hostilityType: HostilityType
    $startTime: Float!
    $endTime: Float!
  ) {
    reportData {
      report(code: $code) {
        events(
          fightIDs: $fightIDs
          dataType: $dataType
          abilityID: $abilityID
          hostilityType: $hostilityType
          startTime: $startTime
          endTime: $endTime
          limit: 10000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

/** One player's casts with `includeResources`: Energy on every cast, Chi on the spenders. */
export const CASTS_WITH_RESOURCES = /* GraphQL */ `
  query CastsWithResources($code: String!, $fightIDs: [Int]!, $sourceID: Int!, $startTime: Float!, $endTime: Float!) {
    reportData {
      report(code: $code) {
        events(
          fightIDs: $fightIDs
          dataType: Casts
          sourceID: $sourceID
          includeResources: true
          startTime: $startTime
          endTime: $endTime
          limit: 10000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;
