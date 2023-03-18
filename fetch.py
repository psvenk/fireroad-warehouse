import os
import sys
import re

import oracledb

CURRENT_YEAR = 2023
MIN_YEAR = 2016

SUBJECT_ID_REGEX = r"([A-Z0-9.-]+)(\[J\])?(,?)"
SCHEDULE_NON_EVENING_REGEX = r"([MTWRFS]+)(\d(\.\d+)?(-\d(\.\d+)?)?)"
SCHEDULE_EVENING_REGEX = r"([MTWRFS]+)\s+EVE\s*\((.+)\)"

username = os.environ.get("WAREHOUSE_USERNAME")
password = os.environ.get("WAREHOUSE_PASSWORD")

if username is None or password is None:
    print("WAREHOUSE_USERNAME and/or WAREHOUSE_PASSWORD not provided")
    exit(1)
elif "/" in username:
    print("WAREHOUSE_USERNAME contains forbidden character '/'")
    exit(1)
elif "@" in password:
    print("WAREHOUSE_PASSWORD contains forbidden character '@'")
    exit(1)

cp = oracledb.ConnectParams(user=username, password=password)
dsn = "warehouse"
del username, password

# We need to use the "thick" mode so that ldap.ora and sqlplus.ora are read
oracledb.init_oracle_client()

def fetch_subject(subject_id):
    with oracledb.connect(dsn, params=cp) as connection:
        with connection.cursor() as cursor:
            out = {}

            cursor.execute("""
                SELECT * FROM cis_course_catalog
                WHERE subject_id = :subject_id
                AND academic_year >= :min_year
                ORDER BY academic_year DESC
            """, subject_id=subject_id, min_year=MIN_YEAR)

            # Return results as dict
            columns = [col[0].lower() for col in cursor.description]
            cursor.rowfactory = lambda *args: dict(zip(columns, args))

            row = cursor.fetchone()

            if row is None:
                print("Subject not found")
                exit(1)

            out["subject_id"] = row["subject_id"]
            out["title"] = row["subject_title"]
            out["total_units"] = row["total_units"]
            out["offered_fall"] = row["is_offered_fall_term"] == "Y"
            out["offered_IAP"] = row["is_offered_iap"] == "Y"
            out["offered_spring"] = row["is_offered_spring_term"] == "Y"
            out["offered_summer"] = row["is_offered_summer_term"] == "Y"
            out["public"] = True
            out["level"] = row["hgn_code"]

            year = int(row["academic_year"])

            if year < CURRENT_YEAR:
                # This is considered a historical subject (for
                # compatibility with FireRoad)
                out["is_historical"] = True
                out["source_semester"] = f"spring-{year}"

            if row["joint_subjects"] is not None:
                out["joint_subjects"] = [
                    normalize_subject_id(x)
                    for x in row["joint_subjects"].split(",")
                ]

            if row["equivalent_subjects"] is not None:
                out["equivalent_subjects"] = [
                    normalize_subject_id(x)
                    for x in row["equivalent_subjects"].split(",")
                ]

            if row["meets_with_subjects"] is not None:
                out["meets_with_subjects"] = [
                    normalize_subject_id(x)
                    for x in row["meets_with_subjects"].split(",")
                ]

            # TODO quarter_information (term_duration)

            if row["is_offered_this_year"] != "Y":
                # Not offered this year
                out["not_offered_year"] = f"{year-1}-{year}"

            instructors = []
            if ((out["offered_fall"] or out["offered_summer"]) and
                    row["fall_instructors"] is not None):
                instructors.append(f"Fall: {row['fall_instructors']}")
            if ((out["offered_spring"] or out["offered_IAP"]) and
                    row["spring_instructors"] is not None):
                instructors.append(f"Spring: {row['spring_instructors']}")
            if instructors:
                out["instructors"] = instructors

            comm_req_raw = row["comm_req_attribute"]
            if comm_req_raw == "CIH":
                row["communication_requirement"] = "CI-H"
            elif comm_req_raw == "CIHW":
                row["communication_requirement"] = "CI-HW"
            # row["communication_requirement"] does not include CI-M

            out["gir_attribute"] = row["gir_attribute"]

            # TODO children, parent

            if row["status_change"] is not None:
                if "New number" in row["status_change"]:
                    print("Subject has been renumbered")
                    exit(1)

                match = re.match(
                    r"Old number:\s+(" + SUBJECT_ID_REGEX + r")",
                    row["status_change"])
                if match:
                    out["old_id"] = normalize_subject_id(match[1])

            out["lecture_units"] = row["lecture_units"]
            out["lab_units"] = row["lab_units"]
            out["design_units"] = row["design_units"]
            out["preparation_units"] = row["preparation_units"]
            out["is_variable_units"] = row["is_variable_units"] == "Y"

            # is_half_class is not populated by the FireRoad scraper and can be
            # added via corrections

            # TODO has_final

            out["description"] = row["subject_description"]

            # TODO prerequisites/corequisites

            out["url"] = row["on_line_page_number"] + "#" + out["subject_id"]

            hass_attribute_raw = row["hass_attribute"]

            if hass_attribute_raw:
                cursor.execute("""
                    SELECT description_in_bulletin FROM cis_hass_attribute
                    WHERE hass_attribute = :hass_attribute
                """, hass_attribute=hass_attribute_raw)

                hass_res = cursor.fetchone()
                if hass_res is not None:
                    out["hass_attribute"] = hass_res[0]


            schedule_fall, schedule_iap, schedule_spring = (
                fetch_schedule(cursor, subject_id, year))
            if schedule_fall:
                out["schedule"] = out["schedule_fall"] = schedule_fall
            if schedule_iap:
                out["schedule"] = out["schedule_IAP"] = schedule_iap
            if schedule_spring:
                out["schedule"] = out["schedule_spring"] = schedule_spring

            # TODO related_subjects

            # TODO course evals

            # TODO support corrections

            return out

def normalize_subject_id(subject_id):
    """
    Normalize a subject ID by stripping leading/trailing whitespace and the "J"
    suffix for joint subjects.
    """
    return subject_id.strip().rstrip("J")

def fetch_schedule(cursor, subject_id, year):
    """
    Given a cursor to the database, fetch the schedule for a subject in a
    specified academic year (given as an int) and form a schedule string in a
    standardized format.

    The format for a schedule is a semicolon-separated list of sections, where
    each section is a comma-separated list in which:
    - the first entry of a section is "Lecture", "Recitation", "Lab", or
      "Design";
    - each subsequent entry of a section is a meeting, where
      + each meeting is either "TBA" or a slash-separated list;
      + the first entry is the room number; e.g.,
          "54-1423", "VIRTUAL", "NORTH SHORE";
      + the second entry is one or more characters from "M", "T", "W", "R",
          "F", "S";
      + the third entry is either "0" or "1";
      + if the third entry is "0", the fourth entry is a non-evening hour;
          e.g., "9" or "1-2.30";
      + if the third entry is "1", the fourth entry is an evening hour;
          e.g., "4-7 PM" or "5.30 PM".

    For example, the following schedule would lead to the following output:

    Schedule:
        Lecture: MWF 10am (10-250)
        Recitation: M 11am (34-101), M 1pm (34-303), M 7pm (34-302), T 10am (34-301)

    Output:
        Lecture,10-250/MWF/0/10;Recitation,34-301/M/0/11,34-302/M/1/7 PM,34-301/T/0/10

    Returns a tuple (fall, iap, spring) where each element may be str or
    NoneType.
    """
    def fetch_term(term_code):
        lectures = []
        recitations = []
        labs = []
        designs = []

        cursor.execute("""
            SELECT meet_place, meet_time, is_lecture_section,
                is_recitation_section, is_lab_section, is_design_section
            FROM subject_offered
            WHERE subject_id = :subject_id
            AND term_code = :term_code
            AND is_master_section = 'N'
            ORDER BY is_lecture_section DESC, is_recitation_section DESC,
                is_lab_section DESC, section_id
        """, subject_id=subject_id, term_code=term_code)
        for meet_place, meet_time, lec, rec, lab, des in cursor:
            if lec == "Y":
                dest = lectures
            elif rec == "Y":
                dest = recitations
            elif lab == "Y":
                dest = labs
            elif des == "Y":
                dest = designs
            else:
                print(f"Encountered unknown section type for subject {subject_id}")
                continue

            if not meet_place or not meet_time:
                dest.append("TBA")
                continue

            for time in meet_time.split(","):
                time = time.strip()

                match = re.match(SCHEDULE_NON_EVENING_REGEX, time)
                if match:
                    days = match[1]
                    hours = match[2]
                    dest.append(f"{meet_place}/{days}/0/{hours}")
                    continue

                match = re.match(SCHEDULE_EVENING_REGEX, time)
                if match:
                    days = match[1]
                    hours = match[2]
                    dest.append(f"{meet_place}/{days}/1/{hours}")
                    continue

                dest.append("TBA")
                print(f'Could not parse schedule "{meet_time}" for subject {subject_id}')

        out = ""
        if lectures:
            out += ";" + ",".join(["Lecture", *lectures])
        if recitations:
            out += ";" + ",".join(["Recitation", *recitations])
        if labs:
            out += ";" + ",".join(["Lab", *labs])
        if designs:
            out += ";" + ",".join(["Design", *designs])
        return out[1:] or None

    fall = fetch_term(f"{year}FA")
    iap = fetch_term(f"{year}JA")
    spring = fetch_term(f"{year}SP")
    return fall, iap, spring

if __name__ == "__main__":
    try:
        subject_id = sys.argv[1]
    except IndexError:
        print(f"Usage: {sys.argv[0]} <subject_id>")
        exit(1)

    out = fetch_subject(subject_id)
    for k, v in out.items():
        print(k.ljust(20) + str(v))
